import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUsageServer } from "../src/server.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

test("detail growth, diagonal quota control and theme transitions work in the real dashboard", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
  const log = `${imports.imports[0].path}/.codex-usage/usage.jsonl`;
  const seed = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]);
  await appendFile(
    log,
    `${Array.from({ length: 80 }, (_, index) =>
      JSON.stringify({
        ...seed,
        model: `overflow-model-${index}`,
        session_id: `overflow-${index}`,
        request_id: `overflow-${index}`,
      }),
    ).join("\n")}\n`,
  );
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageTheme", "light");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator('#presetButtons button[data-preset="all"]').click();
  await page.waitForSelector("#detailList .bar-row");
  const height = () => page.locator(".detail-panel").evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(Math.abs((await height()) - 384) < 1);
  await page.locator('#timelineModes [data-timeline-mode="model"]').click();
  await page.waitForFunction(() => document.querySelector(".detail-panel").getBoundingClientRect().height > 700);
  const geometry = await page.evaluate(() => {
    const detail = document.querySelector(".detail-panel");
    const list = document.querySelector("#detailList");
    return {
      height: detail.getBoundingClientRect().height,
      chartHeight: document.querySelector(".chart-panel").getBoundingClientRect().height,
      scrolls: list.scrollHeight > list.clientHeight,
      thumb: getComputedStyle(list, "::-webkit-scrollbar").width,
      quotaClip: getComputedStyle(document.querySelector(".quota-preset-mode"), "::before").clipPath,
    };
  });
  assert.ok(geometry.height <= 769 && geometry.height >= 767, JSON.stringify(geometry));
  assert.equal(geometry.height, geometry.chartHeight);
  assert.equal(geometry.scrolls, true);
  assert.equal(geometry.thumb, "8px");
  assert.notEqual(geometry.quotaClip, "none");
  await mkdir(new URL("../output/additions-ui/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("../output/additions-ui/layout.png", import.meta.url)),
    fullPage: true,
  });

  for (const fallback of [false, true]) {
    if (fallback)
      await page.evaluate(() => {
        document.startViewTransition = undefined;
      });
    const before = await page.locator("html").getAttribute("data-theme");
    const started = Date.now();
    await page.locator("#themeToggle").click();
    await page.waitForFunction(() => document.documentElement.dataset.themeTransition === "running");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#themeToggle").isDisabled(), true);
    const opacity = await page.evaluate(
      (fallback) =>
        Number(
          getComputedStyle(
            fallback ? document.body.lastElementChild : document.documentElement,
            fallback ? null : "::view-transition-new(root)",
          ).opacity,
        ),
      fallback,
    );
    assert.ok(opacity > 0 && opacity < 1, `intermediate opacity: ${opacity}`);
    await page.evaluate(() => document.querySelector("#themeToggle").click());
    await page.waitForFunction(() => !document.documentElement.dataset.themeTransition);
    assert.ok(Date.now() - started >= 900, "theme transition must last approximately one second");
    assert.equal(await page.locator("html").getAttribute("data-theme"), before === "light" ? "dark" : "light");
    assert.equal(await page.locator("#themeToggle").isEnabled(), true);
  }
  assert.deepEqual(errors, []);
});
