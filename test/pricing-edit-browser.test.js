import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

for (const locale of ["zh-CN", "en-US"]) {
  test(`${locale}: missing model rates can be edited, cancelled, saved and used for recalculation`, async (t) => {
    const runtime = await resolveBrowserRuntime();
    if (!runtime) {
      assert.ok(!process.env.CI, "CI requires a browser runtime");
      return t.skip("No local browser runtime");
    }
    const fixture = await createPaletteFixture();
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
      `${["vendor/Gemini-4-Argon-Contributor", "codex-auto-review"]
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
    };
    await openPricing();
    const row = page.locator(`[data-pricing-model="${model}"]`);
    const fields = page.locator("#modelPricingFields input");
    const apply = page.locator("#applyModelPricingButton");
    const missing = row.locator(".pricing-state-badge.missing");
    for (const scope of ["used", "all"]) {
      await page.locator(`[data-pricing-scope="${scope}"]`).click();
      assert.equal(await row.evaluate((node) => node.tagName), "BUTTON");
      assert.equal(await missing.count(), 1);
      assert.equal(await page.locator("[data-pricing-rematch]").count(), 0);
      await row.focus();
      await row.press("Enter");
      assert.equal(await fields.count(), 4);
      assert.deepEqual(await fields.evaluateAll((inputs) => inputs.map((input) => input.value)), ["", "", "", ""]);
      assert.equal(await apply.isDisabled(), true);
      await fields.first().fill("2");
      assert.equal(await apply.isDisabled(), true);
      await page.locator("#cancelModelPricingButton").click();
      assert.equal(await missing.count(), 1);
    }
    const freeRow = page.locator(".pricing-model-row").filter({ hasText: "codex-auto-review" });
    assert.equal(await freeRow.getAttribute("data-pricing-model"), null);
    assert.equal(await freeRow.locator(".pricing-state-badge.free").count(), 1);
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
    assert.match(await row.innerText(), /2\/0\.5\/8/);
    await page.locator("#cancelPricingButton").click();
    await openPricing();
    assert.equal(await missing.count(), 1, "cancelling the parent dialog discards the new model");
    await row.click();
    for (const [field, value] of Object.entries(rates)) {
      await page.locator(`#modelPricingFields input[data-field="${field}"]`).fill(String(value));
    }
    await apply.click();
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
    assert.deepEqual(errors, []);
  });
}
