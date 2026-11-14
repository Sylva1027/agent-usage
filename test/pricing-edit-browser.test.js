import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pricingProvider } from "../public/pricing-directory.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { automaticPricingFile } from "../src/pricing-store.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

for (const locale of ["zh-CN", "en-US"]) {
  test(`${locale}: model rate groups preserve edits through cancel, save and recalculation`, async (t) => {
    const runtime = await resolveBrowserRuntime();
    if (!runtime) {
      assert.ok(!process.env.CI, "CI requires a browser runtime");
      return t.skip("No local browser runtime");
    }
    const fixture = await createPaletteFixture();
    await writeFile(
      automaticPricingFile({ homeDir: fixture.homeDir }),
      JSON.stringify({
        models: {
          "gpt-6-sol": { fast: { short: { cachedInput: 0.0000004 * 1_000_000, output: 0.12345678901234566 } } },
        },
      }),
    );
    const server = createUsageServer(createPaletteServerOptions(fixture));
    let browser;
    t.after(async () => {
      await browser?.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await fixture.close();
    });
    const model = "gemini-4-argon-contributor";
    const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
    const log = path.join(imports.imports[0].path, ".codex-usage", "usage.jsonl");
    const seed = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]);
    await appendFile(
      log,
      `${[`vendor/${model}`, "codex-auto-review", "gpt-6-sol"]
        .map((name, i) =>
          JSON.stringify({
            ...seed,
            source: "codex",
            channel: "Codex",
            model: name,
            timestamp: new Date().toISOString(),
            session_id: `manual-pricing-${i}`,
            request_id: `manual-pricing-${i}`,
            usage: {
              input: 1_000_000,
              cached: 500_000,
              output: 200_000,
              total: 1_200_000,
              cache_write_input_tokens: 0,
            },
          }),
        )
        .join("\n")}\n`,
    );
    await listenOnFetchPort(server);
    browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((language) => {
      localStorage.setItem("codexUsageAutoRefresh", "off");
      localStorage.setItem("codexUsageLocale", language);
    }, locale);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#homeList .home-row").first().waitFor();
    const openPricing = async () => {
      await page.locator("#updatePricingButton").click();
      await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
      await page.locator(`[data-pricing-provider="${pricingProvider(model).id}"]`).click();
    };
    await openPricing();
    const row = page.locator(`[data-pricing-model="${model}"]`);
    const fields = page.locator("#modelPricingFields input");
    const apply = page.locator("#applyModelPricingButton");
    const missing = row.locator(".pricing-state-badge.missing");
    assert.equal(await row.evaluate((node) => node.tagName), "BUTTON");
    assert.equal(await missing.count(), 1);
    assert.equal(await page.locator("[data-pricing-rematch]").count(), 0);
    await row.focus();
    await row.press("Enter");
    assert.equal(await fields.count(), 4);
    assert.equal(await page.locator("#modelPricingFields .pricing-mode-group").count(), 1);
    assert.equal(await page.locator("#modelPricingFields .pricing-context").count(), 1);
    assert.deepEqual(await fields.evaluateAll((inputs) => inputs.map((input) => input.value)), ["", "", "", ""]);
    assert.equal(await apply.isDisabled(), true);
    await fields.first().fill("2");
    assert.equal(await apply.isDisabled(), true);
    await page.locator("#cancelModelPricingButton").click();
    assert.equal(await missing.count(), 1);
    await row.click();
    for (const field of await fields.all()) await field.fill("0");
    assert.equal(await apply.isEnabled(), true, "explicit zero rates can be applied");
    await fields.first().fill("-1");
    assert.equal(await apply.isDisabled(), true);
    const rates = { input: 2, cachedInput: 0.5, cacheWrite: 0, output: 8 };
    for (const [field, value] of Object.entries(rates)) {
      await page.locator(`#modelPricingFields input[data-field="${field}"]`).fill(String(value));
    }
    await apply.click();
    assert.equal(await missing.count(), 0, "new catalog keys immediately resolve after Apply");
    assert.deepEqual(await row.locator("[data-pricing-rate]").allTextContents(), ["$2", "$0.5", "$8"]);
    for (const width of [320, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      const columns = await page
        .locator("#providerPricingColumns > span")
        .evaluateAll((nodes) => nodes.slice(1).map((node) => node.getBoundingClientRect().right));
      const rates = await row
        .locator("[data-pricing-rate]")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      for (let index = 0; index < rates.length; index++) assert.ok(Math.abs(rates[index] - columns[index]) < 1);
      const layout = await page.locator("#providerPricingDialog").evaluate((node) => ({
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        text: node.innerText,
      }));
      assert.equal(layout.scrollWidth, layout.width, "long model names fit without horizontal overflow");
      assert.doesNotMatch(layout.text, /\d{4}-\d{2}-\d{2}|\d+\s*个模型|百万 tokens/);
    }
    await page.locator("#closeProviderPricingButton").click();
    await page.locator("#cancelPricingButton").click();
    await openPricing();
    assert.equal(await missing.count(), 1, "cancelling the parent dialog discards the new model");
    await row.click();
    for (const [field, value] of Object.entries(rates)) {
      await page.locator(`#modelPricingFields input[data-field="${field}"]`).fill(String(value));
    }
    await apply.click();
    await page.locator("#closeProviderPricingButton").click();
    const saveResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/pricing") && response.request().method() === "PUT",
    );
    await page.locator("#savePricingButton").click();
    assert.equal((await saveResponse).status(), 200);
    await page.locator("#pricingDialog").waitFor({ state: "hidden" });
    const saved = await page.request.get(new URL("/api/pricing", page.url()).href).then((response) => response.json());
    assert.deepEqual(saved.models[model].short, rates);
    assert.deepEqual(saved.models[model].long, rates);
    assert.ok(saved.automatic.manualModels.includes(model));
    const total = await page.evaluate(async (name) => {
      const { state } = await import("/app-state.js");
      return state.summary.timeline.reduce(
        (sum, slot) =>
          sum +
          Object.entries(slot.costByModel || {})
            .filter(([key, cost]) => (cost.model || key) === name)
            .reduce((value, [, cost]) => value + cost.totalUsd, 0),
        0,
      );
    }, model);
    assert.ok(Math.abs(total - 2.85) < 1e-9, `recalculated cost must use manual rates, received ${total}`);
    await page.reload();
    await page.locator("#homeList .home-row").first().waitFor();
    await openPricing();
    assert.equal(await missing.count(), 0);
    await row.click();
    for (const [field, value] of Object.entries(rates)) {
      assert.equal(
        await page.locator(`#modelPricingFields input[data-context="short"][data-field="${field}"]`).inputValue(),
        String(value),
      );
    }
    assert.equal(await apply.isDisabled(), true);
    await page.locator("#cancelModelPricingButton").click();
    await page.locator("#closeProviderPricingButton").click();
    await page.locator('[data-pricing-provider="openai"]').click();
    const tierRow = page.locator('[data-pricing-model="gpt-6-sol"]');
    await tierRow.click();
    assert.deepEqual(
      await page.locator(".pricing-mode-heading").allTextContents(),
      locale === "en-US" ? ["Standard Mode", "Fast Mode"] : ["标准模式", "快速模式"],
    );
    assert.equal(await page.locator("#modelPricingFields .pricing-context").count(), 4);
    assert.equal(await fields.count(), 16);
    assert.equal(
      await page.locator('#modelPricingFields input[data-context="fast.short"][data-field="cachedInput"]').inputValue(),
      "0.4",
    );
    assert.equal(await apply.isDisabled(), true, "display cleanup alone is not an edit");
    const originalValues = await fields.evaluateAll((inputs) => inputs.map((input) => input.value));
    for (const width of [320, 1100]) {
      await page.setViewportSize({ width, height: 480 });
      const layout = await page.locator("#modelPricingDialog").evaluate((dialog) => {
        const cards = [...dialog.querySelectorAll(".pricing-context")].map((card) => card.getBoundingClientRect());
        return {
          width: dialog.clientWidth,
          scrollWidth: dialog.scrollWidth,
          scrollable: dialog.scrollHeight > dialog.clientHeight,
          scrollbar: getComputedStyle(dialog).scrollbarWidth,
          paired: Math.abs(cards[0].top - cards[1].top) < 1,
        };
      });
      assert.equal(layout.scrollWidth, layout.width);
      assert.equal(layout.scrollbar, "none");
      assert.equal(layout.scrollable, true, "short viewports remain scrollable");
      assert.equal(layout.paired, width > 540);
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    const tierRates = { short: 3, long: 7, "fast.short": 6, "fast.long": 14 };
    const tierInput = (tier) => page.locator(`#modelPricingFields input[data-context="${tier}"][data-field="input"]`);
    for (const [tier, value] of Object.entries(tierRates)) await tierInput(tier).fill(String(value));
    await page.locator("#cancelModelPricingButton").click();
    await tierRow.click();
    assert.deepEqual(await fields.evaluateAll((inputs) => inputs.map((input) => input.value)), originalValues);
    for (const [tier, value] of Object.entries(tierRates)) await tierInput(tier).fill(String(value));
    await apply.click();
    await tierRow.click();
    for (const [tier, value] of Object.entries(tierRates))
      assert.equal(await tierInput(tier).inputValue(), String(value));
    assert.equal(await apply.isDisabled(), true);
    await page.locator("#cancelModelPricingButton").click();
    await page.locator("#closeProviderPricingButton").click();
    const saveTiers = page.waitForResponse(
      (response) => response.url().endsWith("/api/pricing") && response.request().method() === "PUT",
    );
    await page.locator("#savePricingButton").click();
    assert.equal((await saveTiers).status(), 200);
    const savedTiers = await page.request
      .get(new URL("/api/pricing", page.url()).href)
      .then((response) => response.json());
    for (const [tier, value] of Object.entries(tierRates)) {
      const getTier = (entry) => tier.split(".").reduce((source, key) => source[key], entry);
      assert.deepEqual(getTier(savedTiers.models["gpt-6-sol"]), {
        ...getTier(saved.models["gpt-6-sol"]),
        input: value,
      });
    }
    assert.deepEqual(errors, []);
  });
}
