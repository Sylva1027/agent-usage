import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

test("manufacturer gallery keeps equal gutters and naturally scrolls without scrollbars", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
  const log = path.join(imports.imports[0].path, ".codex-usage", "usage.jsonl");
  const seed = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]);
  const models = [
    "gemini-ui",
    "deepseek-ui-a",
    "deepseek-ui-b",
    "deepseek-ui-c",
    "deepseek-ui-d",
    "minimax-ui-a",
    "minimax-ui-b",
    "qwen-ui",
    "kimi-ui",
    "grok-ui",
    "mimo-ui",
    "step-ui",
    "llama-ui",
    "hunyuan-ui",
    "mistral-ui",
    "command-ui",
    "ernie-ui",
    "longcat-ui",
    "mercury-ui",
  ];
  await appendFile(
    log,
    `${models
      .map((model, index) =>
        JSON.stringify({
          ...seed,
          model,
          timestamp: new Date().toISOString(),
          source: "codex",
          channel: "Codex",
          session_id: `pricing-scroll-${index}`,
          request_id: `pricing-scroll-${index}`,
        }),
      )
      .join("\n")}\n`,
  );
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({
    executablePath: runtime.executablePath,
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageLocale", "zh-CN");
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#homeList .home-row").first().waitFor();
  const pageFrame = () =>
    page.evaluate(() => {
      const shell = document.querySelector("main.shell").getBoundingClientRect();
      return {
        scrollX,
        scrollY,
        gutter: innerWidth - document.documentElement.clientWidth,
        left: shell.left,
        width: shell.width,
      };
    });
  await page.locator("#updatePricingButton").click();
  await page.locator('[data-pricing-provider="other"]').click();
  await page.locator("#providerPricingDialog").waitFor({ state: "visible" });
  const focusAtClose = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const dialog = document.querySelector("#providerPricingDialog");
        const observer = new MutationObserver(() => {
          if (dialog.open) return;
          observer.disconnect();
          resolve(document.activeElement?.dataset.pricingProvider);
        });
        observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
        document.querySelector("#closeProviderPricingButton").click();
      }),
  );
  assert.equal(focusAtClose, "other", "closing the native dialog restores focus before queued close events");
  await page.locator("#cancelPricingButton").click();

  for (const [width, height, theme, visibleCards, locale] of [
    [1440, 1000, "dark", 12, "zh-CN"],
    [620, 900, "light", 6, "zh-CN"],
    [1440, 680, "dark", 8, "zh-CN"],
    [620, 900, "light", 6, "en-US"],
  ]) {
    await page.setViewportSize({ width, height });
    if ((await page.locator("html").getAttribute("lang")) !== locale) await page.locator("#languageToggle").click();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.locator("#updatePricingButton").scrollIntoViewIfNeeded();
    const background = await pageFrame();
    assert.ok(background.gutter > 0, "exercise a real page scrollbar that consumes layout width");
    await page.locator("#updatePricingButton").click();
    await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
    assert.deepEqual(await pageFrame(), background, "manufacturer dialog keeps the page scrollbar and position");
    assert.equal(await page.locator("[data-pricing-provider]").count(), 19);
    const boxes = await page
      .locator("#pricingSearch, #pricingCurrency, #usdToCnyRate, #refreshPricingButton")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            height: rect.height,
            top: rect.top,
            left: rect.left,
            right: rect.right,
            raised: node.classList.contains("panel-action"),
          };
        }),
      );
    const toolbar = await page.locator(".pricing-toolbar").boundingBox();
    for (const box of boxes) {
      assert.equal(box.height + (box.raised ? 2 : 0), 36);
      assert.ok(Math.abs(box.top - boxes[0].top) < 1, JSON.stringify(boxes));
      assert.ok(box.left >= toolbar.x - 1 && box.right <= toolbar.x + toolbar.width + 1, JSON.stringify(boxes));
    }
    assert.equal(
      await page.locator("#refreshPricingButton").evaluate((node) => getComputedStyle(node).boxShadow),
      await page.locator("#cancelPricingButton").evaluate((node) => getComputedStyle(node).boxShadow),
      "refresh keeps the shared button shadow",
    );
    const geometry = await page.locator("#pricingProviderList").evaluate((node) => {
      const box = node.getBoundingClientRect();
      const cards = [...node.children].map((child) => child.getBoundingClientRect());
      const firstRow = cards.filter((card) => card.top === cards[0].top);
      const style = getComputedStyle(node);
      return {
        left: cards[0].left - box.left,
        right: box.right - firstRow.at(-1).right,
        top: cards[0].top - box.top,
        horizontalGap: firstRow[1].left - firstRow[0].right,
        verticalGap: cards[firstRow.length].top - cards[0].bottom,
        visible: cards.filter((card) => card.top >= box.top && card.bottom <= box.bottom).length,
        overflowY: style.overflowY,
        scrollbarWidth: style.scrollbarWidth,
        scrollbarDisplay: getComputedStyle(node, "::-webkit-scrollbar").display,
        client: node.clientHeight,
        scroll: node.scrollHeight,
      };
    });
    for (const key of ["left", "right", "top", "horizontalGap", "verticalGap"]) assert.equal(geometry[key], 16, key);
    assert.equal(geometry.visible, visibleCards);
    assert.equal(geometry.overflowY, "auto");
    assert.equal(geometry.scrollbarWidth, "none");
    assert.equal(geometry.scrollbarDisplay, "none");
    assert.ok(geometry.scroll > geometry.client);
    const found = await page
      .locator("[data-pricing-provider]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.pricingProvider));
    assert.equal(found.length, 19, found.join(", "));
    assert.equal(new Set(found).size, 19);
    assert.equal(found[0], "deepseek");
    assert.equal(found.at(-1), "other");
    const dotStyles = await page
      .locator('.metric .metric-new, [data-pricing-provider="deepseek"] .metric-new')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return [
            style.width,
            style.height,
            style.top,
            style.right,
            style.borderRadius,
            style.backgroundColor,
            style.boxShadow,
          ];
        }),
      );
    assert.deepEqual(dotStyles.at(-1), dotStyles[0], "provider reminders reuse the home dot's shape, color and glow");
    const gallery = page.locator("#pricingProviderList");
    await gallery.hover();
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => document.querySelector("#pricingProviderList").scrollTop > 0);
    const partial = await gallery.evaluate((node) => node.scrollTop);
    assert.ok(partial < geometry.scroll - geometry.client, "wheel scrolls continuously, not by pages");
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => {
      const node = document.querySelector("#pricingProviderList");
      return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1;
    });
    assert.equal(
      await gallery.evaluate(
        (node) => node.getBoundingClientRect().bottom - node.lastElementChild.getBoundingClientRect().bottom,
      ),
      16,
    );
    await page.locator('[data-pricing-provider="other"]').click();
    await page.locator("#providerPricingDialog").waitFor({ state: "visible" });
    assert.deepEqual(await pageFrame(), background, "model list keeps the same page scrollbar and position");
    assert.equal(
      await page.locator("#pricingDialog").evaluate((node) => node.classList.contains("is-provider-open")),
      true,
    );
    assert.equal(
      await page.locator("#providerPricingDialog").evaluate((node) => getComputedStyle(node).animationName),
      "provider-pricing-enter",
    );
    await page.locator("#pricingModelList [data-pricing-model]").first().click();
    await page.locator("#modelPricingDialog").waitFor({ state: "visible" });
    assert.deepEqual(await pageFrame(), background, "price editor keeps the same page scrollbar and position");
    await page.keyboard.press("Escape");
    await page.locator("#modelPricingDialog").waitFor({ state: "hidden" });
    assert.deepEqual(await pageFrame(), background, "returning to the model list keeps the page in place");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.dataset.pricingProvider === "other");
    assert.equal(
      await page.locator("#pricingDialog").evaluate((node) => node.classList.contains("is-provider-open")),
      false,
    );
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.pricingProvider), "other");
    assert.deepEqual(await pageFrame(), background, "returning to manufacturers keeps the page in place");
    await page.locator("#pricingSearch").fill("深度求索");
    assert.equal(await page.locator("[data-pricing-provider]").count(), 1);
    assert.equal(await gallery.evaluate((node) => node.scrollTop), 0);
    await page.locator("#pricingSearch").fill("");
    assert.equal(await gallery.evaluate((node) => node.scrollTop), 0);
    await page.locator('[data-pricing-provider="deepseek"]').focus();
    for (let index = 1; index < found.length; index++) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.pricingProvider), "other");
    assert.ok(await gallery.evaluate((node) => node.scrollTop > 0), "keyboard focus reveals the last card");
    await page.locator("#cancelPricingButton").click();
    assert.deepEqual(await pageFrame(), background, "closing pricing keeps the page in place");
  }

  if ((await page.locator("html").getAttribute("lang")) !== "zh-CN") await page.locator("#languageToggle").click();
  const openGallery = async () => {
    await page.locator("#updatePricingButton").click();
    await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
  };
  const deepseek = page.locator('[data-pricing-provider="deepseek"]');
  const order = () =>
    page.locator("[data-pricing-provider]").evaluateAll((nodes) => nodes.map((node) => node.dataset.pricingProvider));
  await openGallery();
  await page.locator("#pricingSearch").fill("deepseek-ui-a");
  await deepseek.click();
  assert.equal(await page.locator("#providerPricingTitle").innerText(), "深度求索");
  assert.equal(await page.locator("#pricingModelList .pricing-model-row").count(), 1);
  await page.locator("#closeProviderPricingButton").click();
  await page.locator("#providerPricingDialog").waitFor({ state: "hidden" });
  assert.equal(await deepseek.locator(".metric-new").isVisible(), false);
  await page.locator("#pricingSearch").fill("");
  assert.equal(await deepseek.locator(".metric-new").isVisible(), true, "unseen models hidden by search remain unread");
  await deepseek.click();
  assert.equal(await page.locator("#pricingModelList .pricing-model-row").count(), 4);
  await page.locator("#closeProviderPricingButton").click();
  await page.locator("#providerPricingDialog").waitFor({ state: "hidden" });
  assert.equal(await deepseek.locator(".metric-new").isVisible(), false);
  assert.deepEqual((await order()).slice(-2), ["deepseek", "other"], "viewed providers fall behind unread providers");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.pricingProvider), "deepseek");
  await page.locator("#cancelPricingButton").click();
  await page.reload();
  await page.locator("#homeList .home-row").first().waitFor();
  await openGallery();
  assert.equal(
    await deepseek.locator(".metric-new").isVisible(),
    false,
    "acknowledgement survives cancelling and reloading",
  );
  assert.deepEqual((await order()).slice(-2), ["deepseek", "other"]);
  await page.locator("#cancelPricingButton").click();

  await appendFile(
    log,
    `${["route/DEEPSEEK-UI-A", "deepseek-ui-new"]
      .map((model, index) =>
        JSON.stringify({
          ...seed,
          model,
          timestamp: new Date().toISOString(),
          source: "codex",
          channel: "Codex",
          session_id: `pricing-new-model-${index}`,
          request_id: `pricing-new-model-${index}`,
        }),
      )
      .join("\n")}\n`,
  );
  await page.reload();
  await page.locator("#homeList .home-row").first().waitFor();
  await openGallery();
  assert.equal((await order())[0], "deepseek", "newly ingested usage restores unread priority");
  assert.equal(await deepseek.locator(".metric-new").isVisible(), true);
  assert.equal(
    await deepseek.locator(".pricing-provider-count").innerText(),
    "5个模型",
    "routed duplicates do not count twice",
  );
  await deepseek.click();
  await page.setViewportSize({ width: 320, height: 480 });
  const modelList = page.locator("#pricingModelList");
  const modelScroll = await modelList.evaluate((node) => ({
    scrollbar: getComputedStyle(node).scrollbarWidth,
    client: node.clientHeight,
    scroll: node.scrollHeight,
  }));
  assert.equal(modelScroll.scrollbar, "none");
  assert.ok(modelScroll.scroll > modelScroll.client);
  await modelList.press("End");
  await page.waitForFunction(() => document.querySelector("#pricingModelList").scrollTop > 0);
  await page.locator("#closeProviderPricingButton").click();
  await page.locator("#providerPricingDialog").waitFor({ state: "hidden" });
  assert.equal(await deepseek.locator(".metric-new").isVisible(), false);
  assert.deepEqual((await order()).slice(-2), ["deepseek", "other"]);
  await page.locator("#cancelPricingButton").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [opener, dialog] of [
    ["#skinToggle", "#skinDialog"],
    ["#shareToggle", "#shareDialog"],
    ["#addImportButton", "#importDialog"],
  ]) {
    await page.locator(opener).scrollIntoViewIfNeeded();
    const background = await pageFrame();
    assert.ok(background.gutter > 0);
    await page.locator(opener).click();
    await page.locator(dialog).waitFor({ state: "visible" });
    assert.deepEqual(await pageFrame(), background, `${dialog} keeps the page scrollbar and position`);
    await page.keyboard.press("Escape");
    await page.locator(dialog).waitFor({ state: "hidden" });
    assert.deepEqual(await pageFrame(), background, `closing ${dialog} keeps the page in place`);
  }
  assert.deepEqual(errors, []);
});
