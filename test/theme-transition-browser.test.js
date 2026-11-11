import assert from "node:assert/strict";
import test from "node:test";
import { SKIN_PREFERENCE_KEY } from "../public/skins.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

async function sampleFrame(page) {
  const png = await page.screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    // Background, panel and both fixed characters must all follow the same fade.
    return [
      [5, 5],
      [960, 350],
      [200, 700],
      [1720, 700],
    ].flatMap(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3));
  }, png.toString("base64"));
}

test("theme frames preserve the old scene and fade in both directions, including the fallback", async (t) => {
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });

  for (const fallback of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      ({ key, fallback }) => {
        localStorage.setItem("codexUsageTheme", "light");
        localStorage.setItem("codexUsageAutoRefresh", "off");
        localStorage.setItem(
          key,
          JSON.stringify({ version: 1, skinId: "deepseek", showCharacters: true, opacity: 0.5 }),
        );
        if (fallback) {
          document.startViewTransition = undefined;
          const animate = Element.prototype.animate;
          Element.prototype.animate = function (...args) {
            const animation = animate.apply(this, args);
            if (this.getAttribute("aria-hidden") === "true" && animation.effect.getTiming().duration > 0) {
              animation.pause();
              window.themeAnimations = [animation];
            }
            return animation;
          };
        } else {
          const start = document.startViewTransition.bind(document);
          document.startViewTransition = (...args) => {
            const transition = start(...args);
            transition.ready.then(() => {
              window.themeAnimations = document
                .getAnimations()
                .filter((a) => a.effect?.pseudoElement?.startsWith("::view-transition"));
              for (const animation of window.themeAnimations) animation.pause();
            });
            return transition;
          };
        }
      },
      { key: SKIN_PREFERENCE_KEY, fallback },
    );
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("#homeList .home-row");
    await page.locator('#presetButtons button[data-preset="all"]').click();
    await page.waitForSelector("#detailList .bar-row");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#skinCharacters img")].filter((image) => image.dataset.loaded === "1").length ===
        2,
    );
    await page.evaluate(() => document.fonts.ready);

    for (const scrollY of [0, 500]) {
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      for (const target of ["dark", "light"]) {
        const before = await sampleFrame(page);
        await page.evaluate(() => {
          window.themeAnimations = null;
          document.querySelector("#themeToggle").click();
        });
        await page.waitForFunction(() => window.themeAnimations?.length);
        assert.equal(await page.locator("#themeToggle").isDisabled(), true);
        const frames = [];
        for (const time of [0, 250, 500, 750]) {
          await page.evaluate((time) => {
            for (const animation of window.themeAnimations) animation.currentTime = time;
          }, time);
          frames.push(await sampleFrame(page));
        }
        await page.evaluate(() => {
          document.querySelector("#themeToggle").click();
          for (const animation of window.themeAnimations) animation.finish();
        });
        await page.waitForFunction(() => !document.documentElement.dataset.themeTransition);
        const after = await sampleFrame(page);
        for (const [index, frame] of frames.entries()) {
          for (const [channel, value] of frame.entries()) {
            const expected = before[channel] + ((after[channel] - before[channel]) * index) / 4;
            assert.ok(
              Math.abs(value - expected) <= 3,
              `${fallback ? "fallback" : "native"} → ${target}, scroll ${scrollY}, frame ${index}, channel ${channel}: ${value} vs ${expected}`,
            );
          }
        }
        assert.equal(await page.locator("html").getAttribute("data-theme"), target);
        assert.equal(await page.evaluate(() => window.scrollY), scrollY);
        assert.equal(await page.locator("#themeToggle").isEnabled(), true);
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const target of ["dark", "light"]) {
      await page.evaluate(() => document.querySelector("#themeToggle").click());
      await page.waitForFunction(() => !document.documentElement.dataset.themeTransition);
      assert.equal(await page.locator("html").getAttribute("data-theme"), target);
      assert.equal(await page.locator("#themeToggle").isEnabled(), true);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});
