import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const currencyKey = "codexUsageDisplayCurrency";

async function assertCurrency(page, currency) {
  const view = await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    return {
      currency: state.costScaleTarget,
      rate: state.usdToCnyRate,
      estimate: state.summary.costEstimate,
      timeline: state.summary.timeline,
      metrics: ["totalCost", "inputCost", "cachedInputCost", "outputCost"].map(
        (id) => document.getElementById(id).textContent,
      ),
      details: [...document.querySelectorAll("#detailList .bar-value")].map((node) => node.textContent),
      axis: window.costAxisLabels.filter((text) => /[$¥]/.test(text)).slice(-2),
      label: document.querySelector("#timelineChart").dataset.chartAriaLabel,
    };
  });
  const format = (amount) =>
    new Intl.NumberFormat(currency === "USD" ? "en-US" : "zh-CN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  const convert = (usd, cny) =>
    currency === "USD"
      ? Number(usd || 0) + Number(cny || 0) / view.rate
      : Number(usd || 0) * view.rate + Number(cny || 0);
  assert.equal(view.currency, currency);
  assert.deepEqual(
    view.metrics,
    ["total", "input", "cachedInput", "output"].map((kind) =>
      format(convert(view.estimate[`${kind}Usd`], view.estimate[`${kind}Cny`])),
    ),
  );
  assert.equal(view.axis.length, 2);
  assert.ok(view.axis.every((text) => text.startsWith(currency === "USD" ? "$" : "¥")));
  assert.ok(view.label.includes(currency === "USD" ? "美元为纵轴" : "人民币为纵轴"));
  const models = new Map();
  for (const slot of view.timeline) {
    for (const [key, cost] of Object.entries(slot.costByModel || {})) {
      if (!(cost.totalUsd > 0)) continue;
      const amount = cost.currency === "CNY" ? convert(0, cost.totalUsd) : convert(cost.totalUsd, 0);
      const name = cost.model || key;
      models.set(name, (models.get(name) || 0) + amount);
    }
  }
  assert.deepEqual(view.details, [...models.values()].sort((a, b) => b - a).map(format));
  return view;
}

test("currency choice controls costs, survives refresh, and keeps typed FX separate until saving", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  const startupRefresh = Promise.withResolvers();
  const startupRefreshReady = Promise.withResolvers();
  let browser;
  t.after(async () => {
    startupRefresh.resolve();
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.route(
    "**/api/pricing/refresh",
    async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      startupRefreshReady.resolve();
      await startupRefresh.promise;
      await route.fulfill({ response, json: { ...result, statusChanged: true } });
    },
    { times: 1 },
  );
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      requests.push({ method: request.method(), url: request.url() });
  });
  await page.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageLocale", "zh-CN");
    window.costAxisLabels = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas.id === "timelineChart") window.costAxisLabels.push(String(text));
      return fillText.call(this, text, ...args);
    };
  });
  const waitForPreset = async (preset) => {
    const appState = await page.evaluateHandle(async () => (await import("/app-state.js")).state);
    try {
      await page.waitForFunction(({ state, preset }) => state.summary?.range.preset === preset, {
        state: appState,
        preset,
      });
    } finally {
      await appState.dispose();
    }
  };
  const showAll = async () => {
    await page.locator('[data-preset="all"]').click();
    await waitForPreset("all");
    await page.locator('[data-timeline-mode="cost"]').click();
    await page.locator("#detailList .bar-row").first().waitFor();
  };
  const openPricing = async () => {
    await page.locator("#updatePricingButton").click();
    await page.waitForFunction(() => document.activeElement === document.querySelector("#pricingSearch"));
  };
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#homeList .home-row").first().waitFor();
  await showAll();
  const initial = await assertCurrency(page, "USD");
  assert.ok(initial.estimate.totalUsd > 0 && initial.estimate.totalCny > 0, "fixture covers both native currencies");
  await openPricing();
  const rate = page.locator("#usdToCnyRate");
  await startupRefreshReady.promise;
  assert.equal(await rate.getAttribute("type"), "text");
  assert.equal(await rate.getAttribute("inputmode"), "decimal");
  await rate.fill("6.6652");
  await rate.press("ArrowUp");
  await rate.press("ArrowDown");
  await rate.hover();
  await page.mouse.wheel(0, 100);
  startupRefresh.resolve();
  await page.waitForFunction(() => !document.querySelector("#refreshPricingButton").disabled);
  assert.equal(await rate.inputValue(), "6.6652");
  const beforeSwitch = requests.length;
  await page.locator('[data-display-currency="CNY"]').click();
  assert.equal(requests.length, beforeSwitch, "display-only switch makes no API requests");
  assert.equal((await assertCurrency(page, "CNY")).rate, initial.rate, "draft FX is not used");
  assert.equal(await page.locator('[data-display-currency="CNY"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), currencyKey), "CNY");
  await page.locator("#cancelPricingButton").click();
  await page.locator("#timelineChart").press("Home");
  await page.locator("#usageTooltip").waitFor({ state: "visible" });
  assert.match(await page.locator("#usageTooltip").innerText(), /¥/);
  assert.doesNotMatch(await page.locator("#usageTooltip").innerText(), /\$|≈/);
  await page.locator("#timelineChart").press("Escape");
  await page.reload();
  await page.locator("#homeList .home-row").first().waitFor();
  await showAll();
  await assertCurrency(page, "CNY");
  await openPricing();
  assert.equal(Number(await rate.inputValue()), initial.rate, "cancel discards the FX draft");
  for (const invalid of ["Infinity", "NaN", "0", "-1", "0x10", "0b111", "0o10"]) {
    const before = requests.filter((request) => request.method === "PUT").length;
    await rate.fill(invalid);
    await page.locator("#savePricingButton").click();
    await page.locator("#pricingMessage.error").waitFor();
    assert.equal(requests.filter((request) => request.method === "PUT").length, before, invalid);
  }
  await rate.fill("6.6652");
  await page.locator("#savePricingButton").click();
  await page.locator("#pricingDialog").waitFor({ state: "hidden" });
  assert.equal((await assertCurrency(page, "CNY")).rate, 6.6652);

  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/usage?**",
    async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.locator('[data-preset="month"]').click();
  await pending;
  await openPricing();
  await page.locator('[data-display-currency="USD"]').click();
  release();
  await waitForPreset("month");
  await page.locator("#cancelPricingButton").click();
  await showAll();
  await assertCurrency(page, "USD");
  await page.evaluate((key) => localStorage.setItem(key, "invalid"), currencyKey);
  await page.reload();
  await page.locator("#homeList .home-row").first().waitFor();
  await showAll();
  await assertCurrency(page, "USD");
  await page.setViewportSize({ width: 390, height: 844 });
  await openPricing();
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("#pricingDialog .dialog");
    const controls = document.querySelector(".pricing-controls");
    return {
      overflow: dialog.scrollWidth - dialog.clientWidth,
      controlOverflow: controls.scrollWidth - controls.clientWidth,
      currencyHeight: document.querySelector("#pricingCurrency").getBoundingClientRect().height,
      scopeHeight: document.querySelector("#pricingScope").getBoundingClientRect().height,
    };
  });
  assert.equal(layout.overflow, 0);
  assert.equal(layout.controlOverflow, 0);
  assert.ok(layout.currencyHeight < layout.scopeHeight);
  await page.route(
    /\/api\/pricing(?:\?|$)/,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), usdToCnyRate: 7.25 } });
    },
    { times: 1 },
  );
  await page.route(
    "**/api/pricing/refresh",
    (route) => {
      assert.equal(route.request().postDataJSON().force, true);
      return route.fulfill({ json: { changed: false, statusChanged: true } });
    },
    { times: 1 },
  );
  await page.locator("#refreshPricingButton").click();
  await page.waitForFunction(() => document.querySelector("#usdToCnyRate").value === "7.25");
  assert.deepEqual(errors, []);
});
