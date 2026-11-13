import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SKIN_PREFERENCE_KEY, skinAssetUrl } from "../public/skins.js";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function usageReady(page) {
  await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
}

async function imageReady(page) {
  await page.waitForFunction(() => !document.querySelector("#saveShareImage").disabled);
  await page.locator("#shareImage").evaluate((image) => image.decode());
  return page.evaluate(async () => {
    const hash = async (url) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await fetch(url).then((r) => r.arrayBuffer()))))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const image = document.querySelector("#shareImage");
    const markup = new DOMParser().parseFromString(window.shareCardSvg, "image/svg+xml");
    const card = markup.querySelector(".p-card");
    const character = card.querySelector(".p-character");
    return {
      sha256: await hash(image.src),
      dimensions: [image.naturalWidth, image.naturalHeight],
      theme: card.getAttribute("data-preview-theme"),
      palette: card.getAttribute("style"),
      title: card.querySelector(".p-heading").textContent,
      period: card.querySelector(".p-period")?.textContent ?? null,
      total: card.querySelector(".p-number").textContent,
      metrics: [...card.querySelectorAll(".p-label")].map((label) => label.textContent),
      fee: card.querySelector(".p-fee")?.textContent ?? null,
      artwork: character ? await hash(character.getAttribute("src")) : null,
      classic: card.classList.contains("classic-hybrid"),
    };
  });
}

async function openShare(page) {
  await page.locator("#shareToggle").click();
  await page.locator("#shareDialog").waitFor({ state: "visible" });
  return imageReady(page);
}

async function closeShare(page) {
  await page.keyboard.press("Escape");
  await page.locator("#shareDialog").waitFor({ state: "hidden" });
  assert.ok(await page.locator("#shareToggle").evaluate((button) => button === document.activeElement));
}

const geometry = (page) =>
  page.locator("#shareDialog").evaluate((dialog) => {
    const { x, y, width, height } = dialog.getBoundingClientRect();
    return { x, y, width, height };
  });

async function checkOriginalHint(page, text, screenshot) {
  const dialog = page.locator("#shareOriginalDialog");
  const hint = page.locator("#shareOriginalHint");
  const bounds = () =>
    dialog.evaluate((node) =>
      [node, node.querySelector("img")].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  await page.locator("#openShareImage").click();
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("img").evaluate((image) => image.decode());
  assert.ok(await hint.isVisible());
  assert.equal(await hint.textContent(), text);
  const initial = await bounds();
  if (screenshot) await page.screenshot({ path: screenshot });
  await hint.waitFor({ state: "hidden", timeout: 5000 });
  assert.deepEqual(await bounds(), initial, "The temporary hint does not move or resize the image viewer");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.ok(await page.locator("#shareDialog").isVisible(), "Escape only closes the original image viewer");
  assert.ok(await page.locator("#openShareImage").evaluate((button) => button === document.activeElement));
  await page.locator("#openShareImage").click();
  await dialog.waitFor({ state: "visible" });
  assert.ok(await hint.isVisible(), "Reopening the image shows the hint again");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.ok(await hint.isHidden());
}

test("production share dialog preserves the PNG, layout, snapshot and skin across its controls", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    assert.ok(!process.env.CI, "CI requires a browser runtime");
    return t.skip("No local browser runtime");
  }
  const fixture = await createPaletteFixture();
  const fixtureNow = new Date();
  const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
  const log = `${imports.imports.find((entry) => entry.kind === "project-log").path}/.codex-usage/usage.jsonl`;
  const rows = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const shift = fixtureNow.getTime() - 60_000 - Math.max(...rows.map((row) => Date.parse(row.timestamp)));
  await writeFile(
    log,
    `${rows.map((row) => JSON.stringify({ ...row, timestamp: new Date(Date.parse(row.timestamp) + shift).toISOString() })).join("\n")}\n`,
  );
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((key) => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageTheme", "light");
    localStorage.setItem("codexUsageLocale", "zh-CN");
    localStorage.setItem("codexUsageDisplayCurrency", "CNY");
    localStorage.setItem(key, JSON.stringify({ version: 1, skinId: "classic", showCharacters: true, opacity: 0.5 }));
    // Inspect the SVG actually painted into the PNG, without a production test hook.
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (this.canvas.width === 1080 && this.canvas.height === 1440 && image.src?.startsWith("data:image/svg+xml")) {
        window.shareCardSvg = decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1));
      }
      return drawImage.call(this, image, ...args);
    };
    // Capture the ClipboardItem delivered to the browser API without overwriting the user's clipboard.
    navigator.clipboard.write = async (items) => {
      const blob = await items[0].getType("image/png");
      window.copiedShareImage = {
        type: blob.type,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      };
    };
  }, SKIN_PREFERENCE_KEY);
  await page.clock.setFixedTime(fixtureNow);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await usageReady(page);
  const appState = await page.evaluateHandle(async () => (await import("/app-state.js")).state);
  t.after(() => appState.dispose());
  const selectPreset = async (preset) => {
    await page.locator(`[data-preset="${preset}"]`).click();
    await usageReady(page);
    await page.waitForFunction(({ state, preset }) => state.summary?.range.preset === preset, {
      state: appState,
      preset,
    });
  };

  for (const [preset, period] of [
    ["today", "今日"],
    ["week", "本周"],
    ["month", "本月"],
  ]) {
    await selectPreset(preset);
    assert.ok(await page.locator("#shareToggle").isEnabled());
    const image = await openShare(page);
    assert.equal(image.title, "模型用量");
    assert.equal(image.period, period);
    assert.deepEqual(image.dimensions, [1080, 1440]);
    assert.equal(image.classic, true);
    assert.equal(image.artwork, null);
    const started = page.waitForEvent("download");
    await page.locator("#saveShareImage").click();
    const download = await started;
    const range = await appState.evaluate((state) => state.summary.range);
    const stamp = (value) =>
      new Date(value).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }).replaceAll("-", "");
    const first = stamp(range.start),
      last = stamp(range.end);
    const filename = `usage_${first}${first === last ? "" : `-${last}`}.png`;
    assert.equal(download.suggestedFilename(), filename);
    assert.equal(sha256(await readFile(await download.path())), image.sha256);
    await closeShare(page);
  }
  await selectPreset("all");
  assert.ok(await page.locator("#shareToggle").isDisabled());
  // Exercise unavailable presets even when this fixture has no live quota window.
  for (const preset of ["custom", "recent", "quota_5h", "quota_week"]) {
    await page.evaluate(async (preset) => {
      const { state } = await import("/app-state.js");
      state.preset = preset;
      window.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
    }, preset);
    assert.ok(await page.locator("#shareToggle").isDisabled(), preset);
  }

  await selectPreset("week");
  const baseline = await openShare(page);
  await checkOriginalHint(page, "按 Esc 退出");
  const bounds = await geometry(page);
  assert.equal(await page.locator(".customize-label").evaluate((label) => getComputedStyle(label).fontSize), "13px");
  assert.equal(await page.locator("#shareDialog .share-footer button").count(), 2);
  assert.equal(await page.locator("#shareDialog [data-platform], #shareDialog #systemShare").count(), 0);
  assert.equal(await page.locator("#shareShowCost").isChecked(), false);
  assert.equal(baseline.fee, null);
  await page.locator("#copyShareImage").click();
  await page.waitForFunction(() => window.copiedShareImage);
  assert.deepEqual(await page.evaluate(() => window.copiedShareImage), { type: "image/png", sha256: baseline.sha256 });
  assert.equal(await page.locator("#shareStatus").textContent(), "");
  assert.deepEqual(await geometry(page), bounds);

  for (const [id, excluded] of [
    ["shareMetricFirst", "output"],
    ["shareMetricSecond", "cacheHit"],
  ]) {
    await page.locator(`#${id}`).press("ArrowDown");
    const menu = page.locator(`#${id}Menu`);
    assert.equal(await menu.locator('[role="option"]').count(), 7);
    assert.equal(await menu.locator(`[data-metric="${excluded}"]`).count(), 0);
    await page.keyboard.press("Escape");
    assert.ok(await menu.isHidden());
    assert.ok(await page.locator("#shareDialog").isVisible(), "Escape closes only the metric menu");
    assert.ok(await page.locator(`#${id}`).evaluate((button) => button === document.activeElement));
    assert.deepEqual(await geometry(page), bounds);
  }
  await page.locator("#shareMetricFirst").click();
  await page.locator('#shareMetricFirstMenu [data-metric="sessions"]').click();
  assert.deepEqual((await imageReady(page)).metrics, ["会话", "输出"]);
  assert.deepEqual(await geometry(page), bounds);
  await page.locator("#shareMetricSecond").click();
  assert.equal(await page.locator('#shareMetricSecondMenu [data-metric="sessions"]').count(), 0);
  await page.keyboard.press("Escape");
  await page.locator("#shareMetricFirst").click();
  await page.locator('#shareMetricFirstMenu [data-metric="cacheHit"]').click();
  assert.equal((await imageReady(page)).sha256, baseline.sha256);
  await page.locator("#shareShowCost").check();
  const expectedCny = await appState.evaluate((state) =>
    (state.summary.costEstimate.totalUsd * state.usdToCnyRate + state.summary.costEstimate.totalCny).toFixed(0),
  );
  assert.equal((await imageReady(page)).fee, `API 估算¥${expectedCny}`);
  assert.deepEqual(await geometry(page), bounds);
  await page.locator("#shareShowCost").uncheck();
  assert.equal((await imageReady(page)).sha256, baseline.sha256);
  assert.deepEqual(await geometry(page), bounds);

  // Mutating the live aggregate must not leak into the frozen card on a control rerender.
  await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    state.summary.totals.total += 5_000_000;
    state.summary.models[0].total.total += 5_000_000;
    window.dispatchEvent(new Event("resize"));
    await new Promise(requestAnimationFrame);
  });
  await page.locator("#shareShowCost").check();
  assert.equal((await imageReady(page)).total, baseline.total);
  await page.locator("#shareShowCost").uncheck();
  assert.equal((await imageReady(page)).sha256, baseline.sha256);
  await closeShare(page);
  const changed = await openShare(page);
  assert.notEqual(changed.total, baseline.total);
  assert.notEqual(changed.sha256, baseline.sha256);
  // A real server refresh replaces summary while the native modal stays open.
  await page.evaluate(() => document.querySelector('[data-preset="week"]').click());
  await usageReady(page);
  await page.locator("#shareShowCost").check();
  assert.equal((await imageReady(page)).total, changed.total);
  await page.locator("#shareShowCost").uncheck();
  assert.equal((await imageReady(page)).sha256, changed.sha256);
  await closeShare(page);
  assert.equal((await openShare(page)).sha256, baseline.sha256);
  await closeShare(page);

  const screenshots = new URL("../output/share-dialog-production/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  await page.locator("#languageToggle").click();
  for (const [preset, period] of [
    ["today", "Today"],
    ["week", "This Week"],
    ["month", "This Month"],
  ]) {
    await selectPreset(preset);
    const image = await openShare(page);
    assert.equal(image.title, "Model Usage");
    assert.equal(image.period, period);
    await closeShare(page);
  }
  await selectPreset("week");
  await openShare(page);
  await page.locator("#shareShowCost").check();
  assert.equal((await imageReady(page)).fee, `API estimate¥${expectedCny}`);
  await page.locator("#shareDialog").screenshot({ path: fileURLToPath(new URL("classic-light-en.png", screenshots)) });
  await checkOriginalHint(page, "Press Esc to exit", fileURLToPath(new URL("original-hint-en.png", screenshots)));
  await closeShare(page);
  const expectedUsd = await appState.evaluate((state) => {
    state.costScaleTarget = "USD";
    return (state.summary.costEstimate.totalUsd + state.summary.costEstimate.totalCny / state.usdToCnyRate).toFixed(0);
  });
  await openShare(page);
  await page.locator("#shareShowCost").check();
  assert.equal((await imageReady(page)).fee, `API estimate$${expectedUsd}`);
  await closeShare(page);
  await page.locator("#languageToggle").click();
  await page.locator("#themeToggle").click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark" && !document.querySelector("#themeToggle").disabled,
  );
  await page.locator("#skinToggle").click();
  await page.locator('.skin-card[data-skin-id="deepseek"]').click();
  await page.locator("#closeSkinDialogButton").click();
  const character = await openShare(page);
  assert.equal(character.theme, "dark");
  assert.equal(character.classic, false);
  assert.equal(character.fee, null, "A new share starts with fees hidden");
  assert.equal(await page.locator("#shareShowCost").isChecked(), false);
  const art = await readFile(new URL(`../public${skinAssetUrl("deepseek", "dark", "front")}`, import.meta.url));
  assert.equal(character.artwork, sha256(art));
  await page.locator("#shareDialog").screenshot({ path: fileURLToPath(new URL("waifu-dark-zh.png", screenshots)) });
  await closeShare(page);
  await page.locator("#skinToggle").click();
  await page.locator("#skinCharactersToggle").uncheck();
  await page.locator("#closeSkinDialogButton").click();
  const hidden = await openShare(page);
  assert.equal(hidden.artwork, null);
  assert.equal(hidden.classic, true);
  assert.equal(hidden.palette, character.palette, "Hiding characters preserves the selected skin palette");
  assert.notEqual(hidden.sha256, character.sha256);
  assert.equal(await page.locator("#shareDialog input[type=checkbox]").count(), 1, "No duplicate character control");

  for (const [picker, metric] of [
    ["shareMetricFirst", "sessions"],
    ["shareMetricSecond", "input"],
  ]) {
    await page.locator(`#${picker}`).click();
    await page.locator(`#${picker}Menu [data-metric="${metric}"]`).click();
    await imageReady(page);
  }
  assert.deepEqual((await imageReady(page)).metrics, ["会话", "输入"]);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("codexUsageShareMetrics"))), [
    "sessions",
    "input",
  ]);
  await page.locator("#shareShowCost").check();
  await imageReady(page);
  await closeShare(page);
  const remembered = await openShare(page);
  assert.deepEqual(remembered.metrics, ["会话", "输入"]);
  assert.equal(remembered.fee, null, "Remembering metrics must not persist the cost toggle");
  await closeShare(page);
  await page.reload();
  await usageReady(page);
  assert.deepEqual((await openShare(page)).metrics, ["会话", "输入"], "A reload preserves metric order");
  await closeShare(page);

  for (const saved of ['["cacheHit","cacheHit"]', '["retired","output"]', "invalid JSON"]) {
    await page.evaluate((saved) => localStorage.setItem("codexUsageShareMetrics", saved), saved);
    await page.reload();
    await usageReady(page);
    assert.deepEqual((await openShare(page)).metrics, ["缓存命中", "输出"], `Invalid preference: ${saved}`);
    await closeShare(page);
  }
  assert.deepEqual(errors, []);
});
