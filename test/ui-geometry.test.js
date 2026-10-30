import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";
import { renderPerfModelDetailHtml } from "../public/perf-ui.js";

/*
 * Offline Noto Sans SC subset pins the mixed-font probes independently of installed Noto fonts.
 * shortcut: subset covers 总模型 only; expand it if the mixed-font samples change.
 * Source: https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&text=%E6%80%BB%E6%A8%A1%E5%9E%8B
 *
 * Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
 *
 * This Font Software is licensed under the SIL Open Font License, Version 1.1.
 * This license is copied below, and is also available with a FAQ at:
 * https://scripts.sil.org/OFL
 *
 *
 * -----------------------------------------------------------
 * SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
 * -----------------------------------------------------------
 *
 * PREAMBLE
 * The goals of the Open Font License (OFL) are to stimulate worldwide
 * development of collaborative font projects, to support the font creation
 * efforts of academic and linguistic communities, and to provide a free and
 * open framework in which fonts may be shared and improved in partnership
 * with others.
 *
 * The OFL allows the licensed fonts to be used, studied, modified and
 * redistributed freely as long as they are not sold by themselves. The
 * fonts, including any derivative works, can be bundled, embedded,
 * redistributed and/or sold with any software provided that any reserved
 * names are not used by derivative works. The fonts and derivatives,
 * however, cannot be released under any other type of license. The
 * requirement for fonts to remain under this license does not apply
 * to any document created using the fonts or their derivatives.
 *
 * DEFINITIONS
 * "Font Software" refers to the set of files released by the Copyright
 * Holder(s) under this license and clearly marked as such. This may
 * include source files, build scripts and documentation.
 *
 * "Reserved Font Name" refers to any names specified as such after the
 * copyright statement(s).
 *
 * "Original Version" refers to the collection of Font Software components as
 * distributed by the Copyright Holder(s).
 *
 * "Modified Version" refers to any derivative made by adding to, deleting,
 * or substituting -- in part or in whole -- any of the components of the
 * Original Version, by changing formats or by porting the Font Software to a
 * new environment.
 *
 * "Author" refers to any designer, engineer, programmer, technical
 * writer or other person who contributed to the Font Software.
 *
 * PERMISSION & CONDITIONS
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of the Font Software, to use, study, copy, merge, embed, modify,
 * redistribute, and sell modified and unmodified copies of the Font
 * Software, subject to the following conditions:
 *
 * 1) Neither the Font Software nor any of its individual components,
 * in Original or Modified Versions, may be sold by itself.
 *
 * 2) Original or Modified Versions of the Font Software may be bundled,
 * redistributed and/or sold with any software, provided that each copy
 * contains the above copyright notice and this license. These can be
 * included either as stand-alone text files, human-readable headers or
 * in the appropriate machine-readable metadata fields within text or
 * binary files as long as those fields can be easily viewed by the user.
 *
 * 3) No Modified Version of the Font Software may use the Reserved Font
 * Name(s) unless explicit written permission is granted by the corresponding
 * Copyright Holder. This restriction only applies to the primary font name as
 * presented to the users.
 *
 * 4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
 * Software shall not be used to promote, endorse or advertise any
 * Modified Version, except to acknowledge the contribution(s) of the
 * Copyright Holder(s) and the Author(s) or with their explicit written
 * permission.
 *
 * 5) The Font Software, modified or unmodified, in part or in whole,
 * must be distributed entirely under this license, and must not be
 * distributed under any other license. The requirement for fonts to
 * remain under this license does not apply to any document created
 * using the Font Software.
 *
 * TERMINATION
 * This license becomes null and void if any of the above conditions are
 * not met.
 *
 * DISCLAIMER
 * THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
 * OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
 * COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
 * DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
 * OTHER DEALINGS IN THE FONT SOFTWARE.
 */
const NOTO_SANS_SC_SUBSET =
  "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";

const NEAR = 0.5;
const LONG_PRICING_MODEL = "geometry-long-model-name-".repeat(3);
const FREE_PRICING_MODEL = "geometry-fixture-free";
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= NEAR, `${label}: ${actual} vs ${expected}`);
}

async function createDashboardPage(browser, viewport, locale, theme) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: "Asia/Shanghai" });
  await context.addInitScript(
    ({ locale, theme }) => {
      localStorage.setItem("codexUsageLocale", locale);
      localStorage.setItem("codexUsageTheme", theme);
      localStorage.setItem("codexUsageAutoRefresh", "off");
    },
    { locale, theme },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const archiveRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/history/archives")) archiveRequests.push(request.url());
  });
  await page.clock.setFixedTime(new Date("2026-10-04T13:00:00.000Z"));
  return { context, page, errors, archiveRequests };
}

async function openDashboard(browser, url, viewport, locale, theme) {
  const session = await createDashboardPage(browser, viewport, locale, theme);
  const { page } = session;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator('#presetButtons button[data-preset="all"]').click();
  await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
  await page.locator("#dateRangeButton").click();
  await page.locator('[data-date="2026-09-28"]').click();
  await page.locator('[data-date="2026-10-04"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".comparison-item").length === 3 && document.querySelector("#perfModels table"),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#costEstimateNote p").first().waitFor({ state: "visible" });
  return session;
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return {
        x: r.x + scrollX,
        y: r.y + scrollY,
        width: r.width,
        height: r.height,
        right: r.right + scrollX,
        bottom: r.bottom + scrollY,
        radius: Number.parseFloat(getComputedStyle(element).borderRadius),
      };
    };
    const one = (selector) => {
      const node = document.querySelector(selector);
      return node ? box(node) : null;
    };
    const sectionSelectors = {
      topbar: ".topbar",
      toolbar: ".toolbar",
      metrics: ".metrics",
      prices: ".price-metrics",
      comparison: "#comparisonSummary",
      main: ".main-grid",
      perf: "#perfModelsSection",
      period: ".period-comparison-grid",
      bottom: ".bottom-grid",
    };
    return {
      locale: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      pageWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      shell: one("main.shell"),
      actionOrder: [...document.querySelector(".topbar-actions").children].map((node) => node.id),
      archivePanels: document.querySelectorAll("#historyArchivesPanel").length,
      sections: Object.fromEntries(Object.entries(sectionSelectors).map(([name, selector]) => [name, one(selector)])),
      toolbarControls: [...document.querySelector(".toolbar").children].map(box),
      toolbarHeadings: [...document.querySelectorAll(".toolbar > .control-group > .range-heading")].map(box),
      toolbarWells: ["#presetButtons", "#dateRangeButton", ".auto-refresh-well"].map(one),
      panelWells: [
        [".chart-panel", ".timeline-chart-well"],
        [".perf-model-table-panel", ".comparison-table-frame"],
        [".period-comparison-panel", ".comparison-table-frame"],
      ].map(([panelSelector, wellSelector]) => {
        const panel = document.querySelector(panelSelector);
        const well = panel.querySelector(wellSelector);
        return { selector: panelSelector, panel: box(panel), well: well ? box(well) : null };
      }),
      performanceSlot: one(".perf-model-table-scroll"),
      performanceIdentity: Object.fromEntries(
        [
          ["context", ".perf-model-identity-context"],
          ["model", ".perf-model-identity-model"],
          ["source", ".perf-model-source-name"],
          ["provider", ".perf-model-provider-name"],
          ["name", ".perf-model-title-name"],
          ["effort", ".perf-model-title-effort"],
          ["count", ".perf-model-sample-count"],
        ].map(([key, selector]) => [key, one(selector)]),
      ),
      metricGroups: [...document.querySelectorAll(".metrics")].map((group) => ({
        box: box(group),
        cards: [...group.querySelectorAll(".metric")].map(box),
        values: [...group.querySelectorAll("strong")].map((node) => node.textContent),
      })),
      comparisonCards: [...document.querySelectorAll("#comparisonSummary > article")].map(box),
      panels: [
        ".chart-panel",
        "#detailPanel",
        ".perf-model-table-panel",
        ".perf-model-detail-panel",
        ".period-comparison-panel",
        ".homes-panel",
        ".pricing-note-panel",
      ].map(one),
      mainPanels: [...document.querySelector(".main-grid").children].map(box),
      periodPanels: [...document.querySelector(".period-comparison-grid").children].map(box),
      bottomPanels: [...document.querySelector(".bottom-grid").children].map(box),
      bottomTitles: [...document.querySelectorAll(".bottom-grid .panel-heading > h2")].map(box),
      bottomButtons: [...document.querySelectorAll(".bottom-grid .panel-heading > button")].map(box),
      bottomTextLines: [...document.querySelectorAll(".bottom-grid .panel-heading > *")].map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        return { y: r.y + scrollY, height: r.height };
      }),
      periodSlots: [...document.querySelectorAll(".period-comparison-table")].map(box),
      headingLines: [...document.querySelectorAll("main.shell .panel-heading h2")].map(
        (node) => getComputedStyle(node).lineHeight,
      ),
      totalTokens: document.querySelector("#totalTokens").textContent,
      performanceRows: document.querySelectorAll(".perf-model-data-row").length,
    };
  });
}

function assertMainGeometry(g) {
  const s = g.sections;
  near(g.scrollWidth, g.pageWidth, "page overflow");
  for (const [name, r] of Object.entries(s)) {
    near(r.x, s.topbar.x, `${name} left edge`);
    near(r.right, s.topbar.right, `${name} right edge`);
  }
  near(s.topbar.height, 72, "topbar height");
  near(s.toolbar.height, 107, "toolbar height");
  assert.deepEqual(g.actionOrder, ["languageToggle", "skinToggle", "themeToggle"]);
  assert.equal(g.archivePanels, 0, "maintenance archive panel is absent from dashboard");
  for (const [before, after] of [
    ["topbar", "toolbar"],
    ["toolbar", "metrics"],
    ["metrics", "prices"],
    ["prices", "comparison"],
    ["comparison", "main"],
  ]) {
    near(s[after].y - s[before].bottom, 20, `${before} to ${after} gap`);
  }
  near(g.shell.bottom - s.bottom.bottom, 40, "page bottom padding");
  assert.equal(g.toolbarControls.length, 3);
  for (const [i, control] of g.toolbarControls.entries()) {
    near(control.height, 107, "toolbar control height");
    if (i > 0) near(control.x - g.toolbarControls[i - 1].right, 20, "toolbar control gap");
  }
  assert.equal(g.toolbarHeadings.length, 3, "each toolbar frame has a heading");
  for (const heading of g.toolbarHeadings) {
    near(heading.y, g.toolbarHeadings[0].y, "toolbar heading tops align");
    near(heading.height, 19, "toolbar heading height");
  }
  for (const well of g.toolbarWells) {
    near(well.y, g.toolbarWells[0].y, "toolbar well tops align");
    near(well.height, 52, "toolbar well height");
  }
  for (const { selector, panel, well } of g.panelWells) {
    assert.ok(well, `${selector} content well rendered`);
    near(well.x - panel.x, 21, `${selector} left rim`);
    near(panel.right - well.right, 21, `${selector} right rim`);
    if (selector === ".perf-model-table-panel") {
      near(well.y - panel.y, 21, "performance top rim");
      near(panel.bottom - well.bottom, 21, "performance bottom rim");
      near(well.radius, 9, "performance well radius");
    }
  }
  near(g.performanceSlot.height, 242, "performance header and five-row slot");
  const identity = g.performanceIdentity;
  near(identity.count.y, identity.source.y, "sample count aligns with source");
  near(identity.count.right, identity.context.right, "sample count aligns to the right edge");
  assert.ok(
    identity.count.x >= (identity.provider || identity.source).right + 8,
    "sample count clears source identity",
  );
  near(identity.model.y - identity.context.bottom, 4, "model identity follows source context");
  if (identity.provider) near(identity.provider.x - identity.source.right, 8, "provider follows source closely");
  if (identity.effort) near(identity.effort.x - identity.name.right, 8, "effort follows model closely");
  assert.equal(g.metricGroups.length, 2);
  for (const group of g.metricGroups) {
    near(group.box.height, 104, "metric row height");
    assert.equal(group.cards.length, 6);
    for (const [i, card] of group.cards.entries()) {
      near(card.height, 104, "metric height");
      near(card.radius, 17, "metric radius");
      if (i > 0) near(card.x - group.cards[i - 1].right, 20, "metric gap");
    }
    assert.ok(
      group.values.every((value) => value.trim() && value.trim() !== "-"),
      "metrics rendered",
    );
  }
  near(s.comparison.height, 77, "comparison strip height");
  assert.equal(g.comparisonCards.length, 3);
  for (const [i, card] of g.comparisonCards.entries()) {
    near(card.height, 77, "comparison card height");
    near(card.radius, 17, "comparison radius");
    if (i > 0) near(card.x - g.comparisonCards[i - 1].right, 20, "comparison gap");
  }
  for (const panel of g.panels) near(panel.radius, 21, "panel radius");
  for (const pair of [g.mainPanels, g.periodPanels, g.bottomPanels]) {
    near(pair[0].y, pair[1].y, "paired panel top edges");
    near(pair[1].x - pair[0].right, 20, "paired panel horizontal gap");
  }
  near(g.bottomTitles[0].y, g.bottomTitles[1].y, "directory and cost titles align");
  near(g.bottomButtons[0].y, g.bottomButtons[1].y, "directory and cost buttons align");
  for (const button of g.bottomButtons) near(button.height, 30, "bottom heading button height");
  for (const line of g.bottomTextLines) {
    near(line.y, g.bottomTextLines[0].y, "bottom titles and button text align");
    near(line.height, g.bottomTextLines[0].height, "bottom heading text line height");
  }
  for (const panel of g.mainPanels) near(panel.height, 384, "main panel height");
  for (const panel of g.periodPanels) near(panel.height, 586, "period panel height");
  for (const slot of g.periodSlots) near(slot.height, 496, "period content slot");
  near(s.perf.height, 284, "performance region height");
  for (const [before, after] of [
    ["main", "perf"],
    ["perf", "period"],
    ["period", "bottom"],
  ]) {
    near(s[after].y - s[before].bottom, 24, `${before} to ${after} gap`);
  }
  assert.ok(
    g.headingLines.every((line) => line === "21px"),
    "shared heading line boxes",
  );
  assert.ok(Number.parseFloat(g.totalTokens) > 0, "real usage rendered");
  assert.ok(g.performanceRows > 0, "real performance rows rendered");
}

function assertStableFrames(actual, expected, label) {
  for (const name of ["topbar", "toolbar", "metrics", "prices", "comparison", "main", "perf", "period"]) {
    for (const dimension of ["x", "y", "width", "height"]) {
      near(actual.sections[name][dimension], expected.sections[name][dimension], `${label} ${name} ${dimension}`);
    }
  }
  for (const slot of actual.periodSlots) near(slot.height, 496, `${label} period slot`);
  for (const [before, after] of [
    ["main", "perf"],
    ["perf", "period"],
    ["period", "bottom"],
  ]) {
    near(actual.sections[after].y - actual.sections[before].bottom, 24, `${label} section gap`);
  }
  near(actual.scrollWidth, actual.pageWidth, `${label} horizontal overflow`);
}

async function platformFonts(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, "font sample exists");
    return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
  } finally {
    await cdp.detach();
  }
}

async function dialogGeometry(page, selector) {
  return page.locator(selector).evaluate((shell) => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
        lineHeight: style.lineHeight,
        display: style.display,
      };
    };
    const root = shell.querySelector("form") || shell;
    const children = [...root.children].filter((node) => node.getBoundingClientRect().height > 0);
    return {
      shell: box(shell),
      title: box(shell.querySelector("h2")),
      gaps: children.slice(1).map((node, i) => box(node).y - box(children[i]).bottom),
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: shell.scrollWidth > shell.clientWidth,
    };
  });
}

function assertDialogGeometry(g, label) {
  assert.ok(g.shell.width > 100 && g.shell.height > 100, `${label} visible shell`);
  assert.ok(g.shell.x >= 0 && g.shell.y >= 0, `${label} top/left reachable`);
  assert.ok(g.shell.right <= g.viewport.width && g.shell.bottom <= g.viewport.height, `${label} fits viewport`);
  assert.equal(g.title.lineHeight, "21px", `${label} heading line`);
  assert.equal(g.horizontalOverflow, false, `${label} horizontal overflow`);
  for (const gap of g.gaps) near(gap, 12, `${label} group gap`);
}

async function verifyImportAndSkin(page, fixture) {
  for (const selector of ["#importDialog", "#skinDialog", "#pricingDialog", "#modelPricingDialog"]) {
    assert.equal(await page.locator(selector).isVisible(), false, `${selector} starts hidden`);
  }
  await page.locator("#addImportButton").click();
  await page.waitForFunction(() => document.activeElement?.id === "importPath");
  const empty = await dialogGeometry(page, "#importDialog .dialog");
  assertDialogGeometry(empty, "import");
  const importParts = await page.locator("#importForm").evaluate((form) => {
    const rect = (selector) => form.querySelector(selector).getBoundingClientRect();
    const label = form.querySelector("label:not(.source-option)");
    return {
      feedbackHeight: rect("#importMessage").height,
      legendGap: rect("#sourcePicker").y - rect("legend").bottom,
      pathGap:
        rect(".path-picker").y -
        label.getBoundingClientRect().y -
        Number.parseFloat(getComputedStyle(label).lineHeight),
      heights: ["#importPath", "#pickImportDirectoryButton", "#cancelImportButton", "#submitImportButton"].map(
        (selector) => rect(selector).height,
      ),
    };
  });
  near(importParts.feedbackHeight, 0, "empty import feedback occupies no space");
  near(importParts.legendGap, 8, "legend to source list");
  near(importParts.pathGap, 8, "directory label to controls");
  for (const height of importParts.heights) near(height, 36, "import control height");
  await page.locator("#submitImportButton").click();
  await page.locator("#importMessage.error").waitFor({ state: "visible" });
  const feedback = await dialogGeometry(page, "#importDialog .dialog");
  assertDialogGeometry(feedback, "import feedback");
  near(feedback.shell.height - empty.shell.height, 33, "feedback adds its line and one group gap");
  near((await page.locator("#importMessage").boundingBox()).height, 21, "feedback line");
  const source = page.locator("#sourcePicker input[data-source-id]").first();
  assert.equal(await source.isChecked(), true);
  const sourceId = await source.getAttribute("data-source-id");
  const excludeRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/usage?") && new URL(request.url()).searchParams.get("exclude")?.includes(sourceId),
  );
  await source.uncheck();
  await excludeRequest;
  assert.ok(
    await page.evaluate((id) => JSON.parse(localStorage.getItem("codexUsageExcludedHomes")).includes(id), sourceId),
  );
  const includeRequest = page.waitForResponse(
    (response) => response.url().includes("/api/usage?") && !new URL(response.url()).searchParams.has("exclude"),
  );
  await source.check();
  await includeRequest;
  await page.locator("#autoRefreshSpinner.is-loading").waitFor({ state: "hidden" });
  await page.locator("#pickImportDirectoryButton").click();
  await page.waitForFunction((path) => document.querySelector("#importPath").value === path, fixture.pickedPath);
  assert.equal(await page.locator("#importMessage").evaluate((node) => node.classList.contains("error")), false);
  await page.locator("#submitImportButton").press("Tab");
  await page.waitForFunction(() => document.activeElement?.matches("#sourcePicker input"));
  assert.equal(
    await page.evaluate(() => document.activeElement?.matches("#sourcePicker input")),
    true,
    "import focus wraps",
  );
  await page.locator("#cancelImportButton").click();
  assert.equal(await page.locator("#importDialog").isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "addImportButton");

  await page.locator("#skinToggle").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#skinGrid img")].every((image) => image.complete && image.naturalWidth > 0),
  );
  const skin = await dialogGeometry(page, "#skinDialog .dialog");
  assertDialogGeometry(skin, "skin");
  const skinParts = await page.locator("#skinDialog").evaluate((dialog) => ({
    rows: [
      ...dialog.querySelectorAll(
        ".skin-toggle-row, .skin-opacity-row, #resetSkinClassicButton, #closeSkinDialogButton",
      ),
    ].map((node) => node.getBoundingClientRect().height),
    outputLine: getComputedStyle(dialog.querySelector("output")).lineHeight,
    cards: dialog.querySelectorAll(".skin-card").length,
  }));
  for (const height of skinParts.rows) near(height, 36, "skin control row");
  assert.equal(skinParts.outputLine, "19px");
  assert.equal(skinParts.cards, 10, "all ten character skins are offered");
  assert.equal(await page.locator("#skinCharactersToggle").isDisabled(), true, "classic has no character controls");
  await page.locator('.skin-card[data-skin-id="deepseek"]').click();
  assert.equal(await page.locator('.skin-card[data-skin-id="deepseek"]').getAttribute("aria-checked"), "true");
  await page.locator("#skinOpacity").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#skinOpacityValue").textContent(), "51%");
  await page.locator("#skinCharactersToggle").uncheck();
  assert.equal(await page.locator("#skinCharactersToggle").isChecked(), false);
  await page.locator("#skinCharactersToggle").check();
  await page.locator('.skin-card[data-skin-id="deepseek"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('.skin-card[data-skin-id="deepseek"]').getAttribute("aria-checked"), "false");
  const changedSkin = await dialogGeometry(page, "#skinDialog .dialog");
  near(changedSkin.shell.height, skin.shell.height, "skin controls preserve shell height");
  for (const skinId of ["glm", "gemini", "qwen", "grok", "mimo"]) {
    await page.locator(`.skin-card[data-skin-id="${skinId}"]`).click();
    await page.waitForFunction(
      (id) =>
        document.documentElement.dataset.skin === id &&
        document.querySelectorAll('#skinCharacters img[data-loaded="1"]').length === 2,
      skinId,
    );
    assert.equal(await page.locator(`.skin-card[data-skin-id="${skinId}"]`).getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("codexUsageSkinV1")).skinId), skinId);
  }
  await page.locator("#resetSkinClassicButton").click();
  await page.locator("#closeSkinDialogButton").click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "skinToggle");
  assert.equal(await page.locator("#skinDialog").isVisible(), false);
}

async function verifyPricing(page) {
  await page.locator("#updatePricingButton").click();
  assert.equal(await page.locator('[data-pricing-scope="used"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-pricing-scope="all"]').click();
  const longRow = page.locator(`[data-pricing-model="${LONG_PRICING_MODEL}"]`);
  await longRow.waitFor({ state: "visible" });
  const normal = await dialogGeometry(page, "#pricingDialog .dialog");
  assertDialogGeometry(normal, "pricing");
  assert.equal(await page.locator(".pricing-update-details").getAttribute("open"), null);
  const rows = await page.locator("#pricingModelList").evaluate((list) => ({
    height: list.getBoundingClientRect().height,
    rowHeights: [...list.querySelectorAll(".pricing-model-row")].map((node) => node.getBoundingClientRect().height),
    missing: list.querySelectorAll(".pricing-state-badge.missing").length,
    free: list.querySelectorAll(".pricing-state-badge.free").length,
    hints: [...list.querySelectorAll(".pricing-model-hint")].map((node) => ({
      height: node.getBoundingClientRect().height,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    })),
  }));
  near(rows.height, 240, "pricing list slot");
  assert.ok(rows.rowHeights.length > 2 && rows.missing > 0 && rows.free > 0, "real matched, missing and free rows");
  for (const height of rows.rowHeights) near(height, 52, "pricing row height");
  for (const hint of rows.hints) {
    near(hint.height, 19, "pricing rates stay on one line");
    assert.ok(hint.scrollWidth <= hint.clientWidth, "essential model rates remain fully readable");
  }
  const name = await longRow.locator(".pricing-model-id").evaluate((node) => ({
    ellipsis: getComputedStyle(node).textOverflow,
    clipped: node.scrollWidth > node.clientWidth,
  }));
  assert.deepEqual(name, { ellipsis: "ellipsis", clipped: true });
  for (const selector of ["#pricingSearch", "#usdToCnyRate", "#refreshPricingButton", "#savePricingButton"]) {
    near((await page.locator(selector).boundingBox()).height, 36, "pricing control");
  }
  await longRow.click();
  const native = await dialogGeometry(page, "#modelPricingDialog");
  assertDialogGeometry(native, "native model pricing");
  assert.equal(await page.locator("#modelPricingDialog").evaluate((node) => node.matches(":modal")), true);
  assert.equal(await page.locator(".pricing-model-details").getAttribute("open"), null);
  for (const height of await page
    .locator("#modelPricingFields input")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))) {
    near(height, 36, "model rate control");
  }
  assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), true);
  await page.locator("#cancelModelPricingButton").click();
  assert.equal(await page.locator("#modelPricingDialog").isVisible(), false);
  near(
    await page.locator("#modelPricingDialog").evaluate((node) => node.getBoundingClientRect().height),
    0,
    "closed native dialog excluded",
  );
  await page.locator("#pricingSearch").fill("__no_pricing_geometry_match__");
  await page.locator("#pricingModelList > .empty").waitFor({ state: "visible" });
  const noMatch = await dialogGeometry(page, "#pricingDialog .dialog");
  for (const key of ["x", "y", "width", "height"]) near(noMatch.shell[key], normal.shell[key], `pricing empty ${key}`);
  near((await page.locator("#pricingModelList").boundingBox()).height, 240, "empty pricing slot");
  await page.locator("#pricingSearch").fill("");
  await page.locator('[data-pricing-scope="used"]').click();
  assert.equal(await page.locator('[data-pricing-scope="used"]').getAttribute("aria-pressed"), "true");
  near(
    (await dialogGeometry(page, "#pricingDialog .dialog")).shell.height,
    normal.shell.height,
    "used models preserve shell",
  );
  await page.locator('[data-pricing-scope="all"]').click();
  assert.equal(await page.locator('[data-pricing-scope="all"]').getAttribute("aria-pressed"), "true");
  const all = await dialogGeometry(page, "#pricingDialog .dialog");
  near(all.shell.height, normal.shell.height, "all models preserve shell");
  await page.locator("#pricingSearch").fill(LONG_PRICING_MODEL);
  assert.equal(await page.locator("#pricingModelList .pricing-model-row").count(), 1);
  await page.locator(".pricing-update-details > summary").click();
  assert.ok(
    (await dialogGeometry(page, "#pricingDialog .dialog")).shell.height > normal.shell.height,
    "requested update details can grow",
  );
  await page.locator(".pricing-update-details > summary").click();
  await page.locator("#cancelPricingButton").click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "updatePricingButton");
}

async function hoverSurface(page, selector, expectedHost, failures, options) {
  await page.locator(selector).first().hover(options);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const light = await page.evaluate(
    ({ selector, expectedHost }) => {
      const hosts = [...document.querySelectorAll(".shell [data-spotlight-active]")];
      const host = hosts[0];
      return {
        count: hosts.length,
        matches: Boolean(
          host && expectedHost && host.matches(expectedHost) && host.contains(document.querySelector(selector)),
        ),
        host: host ? host.id || host.className : null,
        mask: host?.style.getPropertyValue("--spotlight-mask") || "",
      };
    },
    { selector, expectedHost },
  );
  if (expectedHost ? light.count !== 1 || !light.matches : light.count !== 0) {
    failures.push(`${selector}: expected ${expectedHost || "no light"}; got ${light.host} (${light.count})`);
  }
  return light;
}

test("UI geometry uses the production app and isolated source fixtures", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    t.skip("No local browser runtime");
    return;
  }
  const palette = await createPaletteFixture();
  const perf = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const codex = createPerfCodexIntegrationFixture();
  const serverOptions = {
    ...createPaletteServerOptions(palette),
    extraZcodeHomes: perf.reportOptions.extraZcodeHomes,
    extraDshHomes: perf.reportOptions.extraDshHomes,
    extraOpencodeHomes: perf.reportOptions.extraOpencodeHomes,
    extraHomes: codex.codexHome,
  };
  const store = new UsageStore(serverOptions);
  try {
    await store.sync({ options: serverOptions });
    const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codex.codexHome));
    assert.ok(home, "geometry fixture must discover its Codex home");
    // Explicit synthetic timing exercises the UI without asserting native capture exists.
    store.importRequestTimingEvidence({
      homeId: String(home.id),
      records: codex.timingRecords,
      reviewedOrigins: ["fixture@1"],
    });
    await store.sync({ options: serverOptions });
  } finally {
    store.close();
  }
  const server = createUsageServer(serverOptions);
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await palette.close();
    perf.close();
    codex.close();
  });
  const imports = JSON.parse(await readFile(palette.importStoreFile, "utf8"));
  const projectLog = `${imports.imports[0].path}/.codex-usage/usage.jsonl`;
  const seed = JSON.parse((await readFile(projectLog, "utf8")).trim().split("\n")[0]);
  await appendFile(
    projectLog,
    `${[LONG_PRICING_MODEL, FREE_PRICING_MODEL]
      .map((model, i) =>
        JSON.stringify({
          ...seed,
          channel: "ZCode",
          source: "zcode",
          model,
          timestamp: "2026-10-02T12:00:00.000Z",
          session_id: `geometry-pricing-${i}`,
          request_id: `geometry-pricing-${i}`,
        }),
      )
      .join("\n")}\n`,
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const catalog = await fetch(`${url}api/pricing`).then((response) => response.json());
  catalog.models[LONG_PRICING_MODEL] = structuredClone(catalog.models["claude-sonnet-4-6"]);
  const seeded = await fetch(`${url}api/pricing`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(catalog),
  });
  assert.equal(seeded.status, 200, await seeded.clone().text());
  for (const viewport of VIEWPORTS) {
    let reference;
    for (const locale of ["zh-CN", "en-US"]) {
      for (const theme of ["light", "dark"]) {
        await t.test(`${viewport.width} ${locale} ${theme}`, async () => {
          const session = await openDashboard(browser, url, viewport, locale, theme);
          try {
            const g = await geometry(session.page);
            assert.equal(g.locale, locale);
            assert.equal(g.theme, theme);
            assertMainGeometry(g);
            if (reference) {
              for (const name of ["topbar", "toolbar", "metrics", "prices", "comparison", "main", "perf", "period"]) {
                for (const dimension of ["x", "y", "width", "height"]) {
                  near(
                    g.sections[name][dimension],
                    reference.sections[name][dimension],
                    `${name} locale/theme ${dimension}`,
                  );
                }
              }
            } else {
              reference = g;
            }
            await verifyImportAndSkin(session.page, palette);
            await verifyPricing(session.page);
            assert.deepEqual(session.archiveRequests, [], "dashboard avoids archive maintenance requests");
            assert.deepEqual(session.errors, []);
          } finally {
            await session.context.close();
          }
        });
      }
    }
  }

  await t.test("the screenshot TPS distribution renders a wide band with exact tick geometry", async () => {
    const session = await openDashboard(browser, url, VIEWPORTS[0], "zh-CN", "light");
    try {
      const narrow = renderPerfModelDetailHtml(
        {
          sourceKind: "workbuddy",
          model: "deepseek-v4.1-flash-sg",
          window: "request",
          state: "ok",
          averageTps: 183.5,
          p10: 183.3,
          p90: 183.8,
          n: 2,
        },
        { locale: "zh-CN" },
      );
      const equal = renderPerfModelDetailHtml(
        {
          sourceKind: "workbuddy",
          model: "single-sample",
          window: "request",
          state: "ok",
          averageTps: 100,
          p10: 100,
          p90: 100,
          n: 1,
        },
        { locale: "zh-CN" },
      );
      const band = await session.page.evaluate(
        ({ narrowHtml, equalHtml }) => {
          const panel = document.createElement("div");
          panel.className = "panel detail-panel perf-model-detail-panel";
          panel.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:244px";
          document.body.append(panel);
          const measure = (html) => {
            panel.innerHTML = html;
            const track = panel.querySelector(".perf-model-band-track");
            const fill = panel.querySelector(".perf-model-band-fill");
            const endpoints = [...panel.querySelectorAll(".perf-model-tick.is-down")];
            const average = panel.querySelector(".perf-model-tick.is-up");
            const trackRect = track.getBoundingClientRect();
            const x = (node) => node.getBoundingClientRect().left - trackRect.left;
            const fillRect = fill.getBoundingClientRect();
            return {
              trackWidth: trackRect.width,
              fillWidth: fillRect.width,
              fillCenter: fillRect.left - trackRect.left + fillRect.width / 2,
              p10: x(endpoints[0]),
              p90: x(endpoints.at(-1)),
              average: x(average),
            };
          };
          const result = { narrow: measure(narrowHtml), equalWidth: measure(equalHtml).fillWidth };
          panel.remove();
          return result;
        },
        { narrowHtml: narrow, equalHtml: equal },
      );
      assert.ok(
        band.narrow.fillWidth > band.narrow.trackWidth / 2,
        `screenshot band exceeds half the track: ${JSON.stringify(band.narrow)}`,
      );
      near(band.narrow.fillCenter, (band.narrow.p10 + band.narrow.p90) / 2, "band midpoint");
      assert.ok(
        Math.abs(band.narrow.fillWidth - (band.narrow.p90 - band.narrow.p10)) < 2,
        "band endpoints allow for the track's inset border",
      );
      near(
        band.narrow.average,
        band.narrow.p10 + (band.narrow.p90 - band.narrow.p10) * 0.4,
        "average uses the same coordinate scale",
      );
      near(band.equalWidth, 4, "equal band minimum width");
    } finally {
      await session.context.close();
    }
  });

  await t.test("real font splitting preserves mixed text, input and placeholder geometry", async (t) => {
    const session = await openDashboard(browser, url, VIEWPORTS[0], "zh-CN", "light");
    try {
      const { page } = session;
      await page.evaluate(async (font) => {
        const cjk = new FontFace("Geometry Noto Sans SC", `url(data:font/ttf;base64,${font})`);
        document.fonts.add(await cjk.load());
        document.documentElement.style.setProperty("--ui-font-sans", '"Segoe UI", "Geometry Noto Sans SC", sans-serif');
      }, NOTO_SANS_SC_SUBSET);
      await page.evaluate(() => document.fonts.ready);
      const chinese = await geometry(page);
      assertMainGeometry(chinese);
      const mixedFonts = await platformFonts(page, ".metric > span:not(.metric-new)");
      assert.ok(
        mixedFonts.some((font) => font.familyName === "Segoe UI" && !font.isCustomFont && font.glyphCount > 0),
        "Latin text uses physical Segoe UI",
      );
      assert.ok(
        mixedFonts.some((font) => font.familyName === "Noto Sans SC" && font.isCustomFont && font.glyphCount > 0),
        "CJK text uses embedded Noto Sans SC",
      );
      const input = page.locator("#modelComparisonSearch");
      const before = await input.boundingBox();
      await input.evaluate((node) => {
        node.placeholder = "Model 模型";
      });
      await input.fill("Model 模型");
      const valueBox = await input.boundingBox();
      near(valueBox.height, before.height, "mixed input height");
      near(valueBox.width, before.width, "mixed input width");
      await input.fill("");
      assert.equal(await input.getAttribute("placeholder"), "Model 模型");
      const placeholderBox = await input.boundingBox();
      near(placeholderBox.height, before.height, "mixed placeholder height");
      await page.locator("#languageToggle").click();
      await page.waitForFunction(() => document.documentElement.lang === "en-US");
      await page.evaluate(() => document.fonts.ready);
      const english = await geometry(page);
      assertMainGeometry(english);
      assertStableFrames(english, chinese, "split-font locale switch");
      const latinFonts = await platformFonts(page, ".metric > span:not(.metric-new)");
      assert.ok(latinFonts.some((font) => font.familyName === "Segoe UI" && font.glyphCount > 0));
      t.diagnostic(JSON.stringify({ mixedFonts, latinFonts }));
      assert.deepEqual(session.errors, []);
    } finally {
      await session.context.close();
    }
  });

  for (const theme of ["light", "dark"]) {
    await t.test(`${theme} whole-page hover lighting preserves surfaces, text and disclosures`, async () => {
      const session = await openDashboard(browser, url, VIEWPORTS[0], "zh-CN", theme);
      const { page } = session;
      const failures = [];
      try {
        const normal = await geometry(page);
        const disclosures = await page.locator("details").evaluateAll((nodes) => nodes.map((node) => node.open));
        const targets = [
          [".topbar h1", ".topbar"],
          ["#skinToggle", "#skinToggle"],
          ["#languageToggle", "#languageToggle"],
          ["#themeToggle", "#themeToggle"],
          [".range-controls .range-heading", ".range-controls"],
          [".date-range-controls .range-heading", ".date-range-controls"],
          ["#dateRangeButton", null],
          ["#autoRefreshStatus", "#autoRefreshStatus", { position: { x: 8, y: 8 } }],
          ["#calendarZoneSelect", null],
          ["#timelinePanelTitle", ".chart-panel"],
          ['#timelineModes button[aria-pressed="true"]', '#timelineModes button[aria-pressed="true"]'],
          ["#timelineChart", null],
          ["#detailPanelTitle", "#detailPanel"],
          ["#detailList .bar-name", "#detailPanel"],
          ["#detailList .bar-track", "#detailPanel"],
          [".perf-model-table thead", null],
          [".perf-model-row-action", null],
          [".perf-model-hero", ".perf-model-detail-panel"],
          [".perf-model-band-track", ".perf-model-detail-panel"],
          [".period-comparison-panel h2", ".period-comparison-panel"],
          ["#modelComparisonSearch", null],
          ["#repositoryComparisonSearch", null],
          ["#modelComparisonTable .comparison-table-scroll", null],
          ["#repositoryComparisonTable .comparison-table-scroll", null],
          ["#modelComparisonTable .comparison-table-footer", ".period-comparison-panel"],
          ["#repositoryComparisonTable .comparison-table-footer", ".period-comparison-panel"],
          [".homes-panel h2", ".homes-panel"],
          ["#addImportButton", "#addImportButton"],
          ["#homeList .home-row", null],
          [".pricing-note-panel h2", ".pricing-note-panel"],
          ["#updatePricingButton", "#updatePricingButton"],
          ["#costEstimateNote p", null],
        ];
        for (const [selector, host, options] of targets) await hoverSurface(page, selector, host, failures, options);
        for (const id of await page.locator(".metric > strong").evaluateAll((nodes) => nodes.map((node) => node.id))) {
          await hoverSurface(page, `.metric:has(#${id}) > span:not(.metric-new)`, ".metric", failures);
          await hoverSurface(page, `#${id}`, null, failures);
        }
        for (let i = 1; i <= 3; i += 1) {
          await hoverSurface(
            page,
            `.comparison-item:nth-child(${i}) > span:first-of-type`,
            ".comparison-item",
            failures,
          );
          await hoverSurface(page, `.comparison-item:nth-child(${i}) > strong`, null, failures);
        }
        await hoverSurface(page, ".perf-model-hero", ".perf-model-detail-panel", failures);
        const textLayers = await page.locator(".perf-model-detail-panel").evaluate((panel) => {
          const light = Number(getComputedStyle(panel, "::after").zIndex);
          return [...panel.querySelectorAll(".perf-model-detail-head,.perf-model-hero,.perf-model-tick")].map(
            (node) => ({
              name: node.className,
              aboveLight: Number(getComputedStyle(node).zIndex) > light,
            }),
          );
        });
        for (const node of textLayers) if (!node.aboveLight) failures.push(`${node.name}: text sits below the light`);
        for (const [button, menu] of [
          ["#recentMenuButton", "#recentRangeMenu"],
          ["#calendarZoneSelect", "#calendarZoneMenu"],
        ]) {
          await page.locator(button).click();
          await hoverSurface(page, menu, menu, failures, { position: { x: 3, y: 20 } });
          await hoverSurface(page, `${menu} button`, null, failures);
          await page.locator(button).click();
        }
        await page.locator("#dateRangeButton").click();
        await hoverSurface(page, ".date-picker-nav", null, failures);
        await hoverSurface(page, ".date-picker-day", null, failures);
        await page.locator("#dateRangeButton").click();
        for (const [open, dialog, close] of [
          ["#addImportButton", "#importDialog", "#cancelImportButton"],
          ["#skinToggle", "#skinDialog", "#closeSkinDialogButton"],
          ["#updatePricingButton", "#pricingDialog", "#cancelPricingButton"],
        ]) {
          await page.locator(open).click();
          await hoverSurface(page, `${dialog} .dialog-heading`, null, failures);
          await page.locator(close).click();
        }
        await page.mouse.move(0, 0);
        assert.deepEqual(
          await page.locator("details").evaluateAll((nodes) => nodes.map((node) => node.open)),
          disclosures,
        );
        assertStableFrames(await geometry(page), normal, "hover sweep");
        assertMainGeometry(await geometry(page));
        assert.deepEqual(session.errors, []);
        assert.deepEqual(failures, []);
      } finally {
        await session.context.close();
      }
    });
  }

  await t.test("a real isolated layout break fails, and removing it passes", async (t) => {
    const session = await openDashboard(browser, url, VIEWPORTS[0], "en-US", "dark");
    try {
      assertMainGeometry(await geometry(session.page));
      const brokenStyle = await session.page.addStyleTag({ content: ".toolbar { transform: translateX(8px); }" });
      const broken = await geometry(session.page);
      assert.throws(() => assertMainGeometry(broken), /left edge/);
      await brokenStyle.evaluate((node) => node.remove());
      assertMainGeometry(await geometry(session.page));
      t.diagnostic("An isolated 8px toolbar displacement was rejected; removing it restored a passing geometry check.");
    } finally {
      await session.context.close();
    }
  });

  await t.test(
    "long values and names stay inside their slots; skins and visible cost details keep their intended geometry",
    async () => {
      const session = await openDashboard(browser, url, VIEWPORTS[0], "zh-CN", "light");
      try {
        const { page } = session;
        const normal = await geometry(page);
        await page.evaluate(() => {
          document.querySelector("#totalTokens").textContent = "123,456,789,012,345,678.90";
          document.querySelector(".metric > span:not(.metric-new)").textContent =
            "Long metric label 很长的指标标签 ".repeat(6);
          document.querySelector(".perf-model-name").textContent = "long-model-name-".repeat(12);
        });
        assertMainGeometry(await geometry(page));
        assertStableFrames(await geometry(page), normal, "long content");
        const overflow = await page.locator("#totalTokens").evaluate((node) => {
          // A pending chart redraw can replace the probe between browser calls.
          node.textContent = "123,456,789,012,345,678.90";
          return {
            clipped: node.scrollWidth > node.clientWidth,
            fontSize: getComputedStyle(node).fontSize,
            whiteSpace: getComputedStyle(node).whiteSpace,
            textOverflow: getComputedStyle(node).textOverflow,
          };
        });
        assert.deepEqual(overflow, { clipped: true, fontSize: "24px", whiteSpace: "nowrap", textOverflow: "ellipsis" });
        await page.locator("#skinToggle").click();
        await page.locator('.skin-card[data-skin-id="deepseek"]').click();
        await page.locator("#closeSkinDialogButton").click();
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.skin === "deepseek" &&
            document.querySelectorAll('#skinCharacters img[data-loaded="1"]').length > 0,
        );
        assertStableFrames(await geometry(page), normal, "character skin");
        await page.locator("#skinToggle").click();
        await page.locator("#resetSkinClassicButton").click();
        await page.locator("#closeSkinDialogButton").click();
        await page.waitForFunction(() => document.documentElement.dataset.skin === "classic");
        assertStableFrames(await geometry(page), normal, "classic skin");
        const pricingPanel = page.locator(".pricing-note-panel");
        assert.equal(await pricingPanel.locator("details, summary").count(), 0, "cost details have no disclosure");
        assert.ok(await page.locator("#costEstimateNote").isVisible(), "cost details are directly visible");
        const beforeGrowth = (await geometry(page)).sections.bottom.height;
        await page
          .locator("#homeList")
          .evaluate((node) => node.append(node.querySelector(".home-row").cloneNode(true)));
        const grown = await geometry(page);
        assert.ok(grown.sections.bottom.height > beforeGrowth, "directory lists grow downwards");
        near(grown.shell.bottom - grown.sections.bottom.bottom, 40, "growing list keeps page bottom padding");
        assert.deepEqual(session.errors, []);
      } finally {
        await session.context.close();
      }
    },
  );

  const loadingScreenshots = new URL("../output/comparison-loading/", import.meta.url);
  await mkdir(loadingScreenshots, { recursive: true });
  await t.test("comparison frames are visible before the app module loads", async () => {
    const session = await createDashboardPage(browser, VIEWPORTS[0], "zh-CN", "dark");
    const release = Promise.withResolvers();
    let completion = Promise.resolve();
    try {
      await session.page.route("**/app.js", (route) => {
        completion = release.promise.then(() => route.continue());
        return completion;
      });
      await session.page.goto(url, { waitUntil: "commit" });
      const cards = session.page.locator("#comparisonSummary > article");
      await cards.last().waitFor({ state: "visible" });
      assert.equal(await cards.count(), 3);
      assert.deepEqual(await cards.locator("strong").allTextContents(), ["—", "—", "—"]);
      const before = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      await session.page.screenshot({ path: fileURLToPath(new URL("first-paint-zh-CN-dark.png", loadingScreenshots)) });
      release.resolve();
      await session.page.waitForFunction(() =>
        Number.isFinite(Number.parseFloat(document.querySelector("#totalTokens")?.textContent)),
      );
      const after = (await geometry(session.page)).comparisonCards;
      for (const [i, card] of after.entries()) {
        for (const dimension of ["x", "y", "width", "height"])
          near(card[dimension], before[i][dimension], `first paint comparison ${dimension}`);
      }
      assert.deepEqual(session.errors, []);
    } finally {
      release.resolve();
      await completion;
      await session.context.close();
    }
  });

  for (const [locale, theme] of [
    ["zh-CN", "light"],
    ["en-US", "dark"],
  ]) {
    await t.test(`${locale} ${theme} real empty, unavailable, loading and error states`, async (t) => {
      const normalSession = await openDashboard(browser, url, VIEWPORTS[0], locale, theme);
      const normal = await geometry(normalSession.page);
      const states = [];
      try {
        const { page } = normalSession;
        await page.locator('#presetButtons button[data-preset="all"]').click();
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll("#comparisonSummary strong")].length === 3 &&
            [...document.querySelectorAll("#comparisonSummary strong")].every((node) => node.textContent === "—"),
        );
        const unavailable = await geometry(page);
        assert.equal(unavailable.comparisonCards.length, 3);
        states.push(["unavailable comparison", unavailable]);
        await page.locator('#presetButtons button[data-preset="today"]').click();
        await page.locator("#detailList .empty").waitFor({ state: "visible" });
        await page.locator(".perf-model-table-panel > .perf-model-empty").waitFor({ state: "visible" });
        await page.locator("#modelComparisonSearch").fill("__no_geometry_match__");
        await page.locator("#repositoryComparisonSearch").fill("__no_geometry_match__");
        await page.locator("#modelComparisonTable > .empty").waitFor({ state: "visible" });
        await page.locator("#repositoryComparisonTable > .empty").waitFor({ state: "visible" });
        states.push(["real empty state", await geometry(page)]);
        assert.deepEqual(normalSession.errors, []);
      } finally {
        await normalSession.context.close();
      }

      const loading = await createDashboardPage(browser, VIEWPORTS[0], locale, theme);
      const release = Promise.withResolvers();
      let completion = Promise.resolve();
      try {
        const usageRequest = loading.page.waitForRequest((request) => request.url().includes("/api/usage?"));
        await loading.page.route("**/api/usage?**", (route) => {
          completion = release.promise.then(() =>
            route.fulfill({ status: 503, json: { error: "Geometry fixture unavailable" } }),
          );
          return completion;
        });
        await loading.page.goto(url, { waitUntil: "domcontentloaded" });
        await usageRequest;
        await loading.page.waitForFunction(() => window.__skinTestHook);
        assert.deepEqual(await loading.page.locator("#comparisonSummary strong").allTextContents(), ["—", "—", "—"]);
        await loading.page.screenshot({
          path: fileURLToPath(new URL(`loading-${locale}-${theme}.png`, loadingScreenshots)),
        });
        states.push(["initial loading", await geometry(loading.page)]);
        release.resolve();
        await loading.page.waitForFunction(() =>
          document.querySelector("#autoRefreshError").classList.contains("is-error"),
        );
        states.push(["initial API error", await geometry(loading.page)]);
        await loading.page.locator("#autoRefreshError").click();
        const errorText = loading.page.locator("#autoRefreshErrorText");
        assert.match(await errorText.inputValue(), locale === "en-US" ? /HTTP 503/ : /Geometry fixture unavailable/);
        assert.ok((await errorText.boundingBox()).height >= 36, "refresh error keeps two readable text lines");
        states.push(["refresh error details", await geometry(loading.page)]);
        await loading.page.locator("#autoRefreshErrorBack").click();
        assert.equal(await loading.page.locator("#autoRefreshErrorDetails").isVisible(), false);
        assert.equal(await loading.page.evaluate(() => document.activeElement?.id), "autoRefreshError");
        assert.deepEqual(loading.errors, []);
      } finally {
        release.resolve();
        await completion;
        await loading.context.close();
      }
      t.diagnostic(
        JSON.stringify(
          states.map(([label, g]) => ({
            label,
            main: g.sections.main.height,
            perf: g.sections.perf.height,
            period: g.sections.period.height,
          })),
        ),
      );
      for (const [label, state] of states) {
        assertStableFrames(state, normal, label);
        if (label === "unavailable comparison") continue;
        assert.equal(state.comparisonCards.length, 3, `${label} comparison frames remain visible`);
        for (const [i, card] of state.comparisonCards.entries()) {
          for (const dimension of ["x", "y", "width", "height"])
            near(card[dimension], normal.comparisonCards[i][dimension], `${label} comparison ${dimension}`);
        }
      }
    });
  }

  for (const locale of ["zh-CN", "en-US"]) {
    await t.test(`${locale} model edits survive save, recalculation and reopening`, async () => {
      const session = await openDashboard(browser, url, VIEWPORTS[0], locale, "light");
      try {
        const { page } = session;
        await page.locator("#updatePricingButton").click();
        await page.locator('[data-pricing-scope="all"]').click();
        const row = page.locator(`[data-pricing-model="${LONG_PRICING_MODEL}"]`);
        await row.click();
        const input = page.locator('#modelPricingFields input[data-context="short"][data-field="input"]');
        const nextInput = Number(await input.inputValue()) + 0.125;
        await input.fill("-1");
        assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), true);
        await input.fill(String(nextInput));
        assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), false);
        await page.locator("#applyModelPricingButton").click();
        assert.equal(await page.locator("#modelPricingDialog").isVisible(), false);
        assert.ok((await row.locator(".pricing-model-hint").textContent()).includes(String(nextInput)));
        const rate = page.locator("#usdToCnyRate");
        const nextRate = Number((Number(await rate.inputValue()) + 0.01).toFixed(2));
        await rate.fill(String(nextRate));
        const beforeError = await dialogGeometry(page, "#pricingDialog .dialog");
        await page.route("**/api/pricing", (route) =>
          route.request().method() === "PUT"
            ? route.fulfill({ status: 503, json: { error: "Fixture save unavailable" } })
            : route.continue(),
        );
        await page.locator("#savePricingButton").click();
        await page.locator("#pricingMessage.error").waitFor({ state: "visible" });
        const failed = await dialogGeometry(page, "#pricingDialog .dialog");
        assertDialogGeometry(failed, "pricing save feedback");
        near(failed.shell.height - beforeError.shell.height, 33, "save feedback grows by one line and gap");
        assert.equal(await page.locator("#savePricingButton").isEnabled(), true);
        await page.unroute("**/api/pricing");
        const savedResponse = page.waitForResponse(
          (response) => response.url().endsWith("/api/pricing") && response.request().method() === "PUT",
        );
        await page.locator("#savePricingButton").click();
        const saved = await savedResponse;
        assert.equal(saved.status(), 200);
        const payload = saved.request().postDataJSON();
        assert.equal(payload.models[LONG_PRICING_MODEL].short.input, nextInput);
        assert.equal(payload.usdToCnyRate, nextRate);
        await page.locator("#pricingDialog").waitFor({ state: "hidden" });
        const persisted = await page.request.get(`${url}api/pricing`);
        assert.equal(persisted.status(), 200);
        const current = await persisted.json();
        assert.equal(current.models[LONG_PRICING_MODEL].short.input, nextInput);
        assert.equal(current.usdToCnyRate, nextRate);
        await page.locator("#updatePricingButton").click();
        assert.equal(Number(await rate.inputValue()), nextRate, "reopening uses the newly saved catalog");
        await page.locator('[data-pricing-scope="all"]').click();
        await row.click();
        assert.equal(Number(await input.inputValue()), nextInput, "reopening uses the newly saved model rate");
        assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), true);
        await page.locator("#cancelModelPricingButton").click();
        await page.locator("#cancelPricingButton").click();
        await page.locator("#languageToggle").click();
        assert.equal(await page.locator("html").getAttribute("lang"), locale === "zh-CN" ? "en-US" : "zh-CN");
        await page.locator("#updatePricingButton").click();
        assert.equal(Number(await rate.inputValue()), nextRate, "language switch preserves saved rates");
        await page.locator("#cancelPricingButton").click();
        assert.deepEqual(session.errors, []);
      } finally {
        await session.context.close();
      }
    });
  }
});
