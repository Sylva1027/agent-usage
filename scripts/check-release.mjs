import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import {
  createPaletteFixture,
  createPaletteServerOptions,
  FIXTURE_TOTAL_TOKENS,
} from "../test-support/skin-palette-fixture.mjs";
import { resolveBrowserRuntime } from "./skin-palette/capture.mjs";
import { SKIN_PREFERENCE_KEY, SKINS } from "../public/skins.js";
import {
  ROOT,
  commonHashes,
  extractChecked,
  nativeCheck,
  releaseDirectory,
  removeTemporary,
  sha256,
} from "./package-release.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const browserRequested = args.includes("--browser");
const positional = args.filter((arg) => arg !== "--browser");
assert.ok(
  positional.length <= 1 && !positional[0]?.startsWith("--"),
  "Usage: node scripts/check-release.mjs [output/release-directory] [--browser]",
);
const directory = await releaseDirectory(ROOT, positional[0] || "output/releases");
const manifest = JSON.parse(await readFile(path.join(directory, "release-manifest.json"), "utf8"));
assert.match(manifest.releaseVersion, /^\d+\.\d+[a-z]?$/);
const core = commonHashes(manifest.variants.standard.files, manifest.variants.waifu.files);
assert.deepEqual(core, manifest.core);
assert.equal(sha256(JSON.stringify(core)), manifest.coreSha256);
const work = await mkdtemp(path.join(directory, ".check-"));
const report = {
  version: manifest.version,
  releaseVersion: manifest.releaseVersion,
  coreSha256: manifest.coreSha256,
  browser: "not-run",
  editions: {},
};
let browser;

async function checkPage(browser, url, edition, locale, viewport) {
  const context = await browser.newContext({ locale, viewport, timezoneId: "Asia/Shanghai" });
  const preference = { version: 1, skinId: "deepseek", showCharacters: true, opacity: 0.63 };
  await context.addInitScript(
    ({ key, preference, locale }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(preference));
      if (!localStorage.getItem("codexUsageTheme")) localStorage.setItem("codexUsageTheme", "light");
      if (!localStorage.getItem("codexUsageLocale")) localStorage.setItem("codexUsageLocale", locale);
      localStorage.setItem("codexUsageAutoRefresh", "off");
    },
    { key: SKIN_PREFERENCE_KEY, preference, locale },
  );
  const page = await context.newPage();
  const errors = [];
  const skinRequests = [];
  const shareImages = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    const failure = request.failure()?.errorText;
    if (pathname === "/api/usage-events") return;
    if (pathname === "/api/imports/discover" && failure === "net::ERR_ABORTED") return;
    errors.push(`${failure} ${request.url()}`);
  });
  page.on("request", (request) => {
    if (/\/(?:skin[^/]*\.(?:js|css|json|html)|assets\/skins\/)/.test(new URL(request.url()).pathname))
      skinRequests.push(request.url());
  });
  await page.clock.setFixedTime(new Date("2026-10-04T13:00:00.000Z"));
  async function ready() {
    await page.waitForFunction(() => Number.parseFloat(document.querySelector("#totalTokens")?.textContent) > 0);
    assert.equal(await page.locator("html").getAttribute("data-edition"), edition);
  }
  async function appearance(theme) {
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme-transition"));
    if (edition === "standard") {
      assert.equal(await page.locator("#skinToggle, #skinDialog, #skinCharacters").count(), 0);
      const declarations = await page.locator("html").evaluate((root) => ({
        skin: root.dataset.skin ?? null,
        inlineColors: Array.from(root.style).filter((name) => name.startsWith("--")),
        bg: getComputedStyle(root).getPropertyValue("--bg").trim().toLowerCase(),
      }));
      assert.deepEqual(declarations, { skin: null, inlineColors: [], bg: theme === "dark" ? "#15181c" : "#cfd8e1" });
      assert.deepEqual(skinRequests, [], "Standard edition requested skin resources");
    } else {
      assert.equal(await page.locator("#skinToggle").count(), 1);
      assert.equal(await page.locator("html").getAttribute("data-skin"), "deepseek");
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll("#skinCharacters img")];
        return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
      });
      const urls = await page
        .locator("#skinCharacters img")
        .evaluateAll((images) => images.map((img) => new URL(img.src).pathname));
      assert.deepEqual(
        urls.sort(),
        Object.values(SKINS.find((skin) => skin.id === "deepseek").variants[theme].assets).sort(),
      );
    }
    assert.deepEqual(
      JSON.parse(await page.evaluate((key) => localStorage.getItem(key), SKIN_PREFERENCE_KEY)),
      preference,
    );
  }
  async function shareImage(preset, theme) {
    await page.locator(`[data-preset="${preset}"]`).click();
    await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
    const toggle = page.locator("#shareToggle");
    await toggle.click();
    const dialog = page.locator("#shareDialog");
    await dialog.waitFor({ state: "visible" });
    const save = dialog.locator("#saveShareImage");
    await page.waitForFunction((button) => !button.disabled, await save.elementHandle());
    const preview = dialog.locator("#shareImage");
    await preview.evaluate(async (image) => await image.decode());
    const imageData = await preview.evaluate(async (image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await fetch(image.src).then((response) => response.arrayBuffer()))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    }));
    assert.equal(imageData.width, 1080);
    assert.equal(imageData.height, 1440);
    assert.equal(await dialog.locator(".dialog-actions button").count(), 2, "Share actions must remain copy/save only");
    const downloadStarted = page.waitForEvent("download");
    await save.click();
    const download = await downloadStarted;
    const filename = download.suggestedFilename();
    assert.match(filename, /^usage_\d{8}(?:-\d{8})?\.png$/);
    const bytes = await readFile(await download.path());
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1080);
    assert.equal(bytes.readUInt32BE(20), 1440);
    assert.equal(sha256(bytes), imageData.sha256, "Saved image differs from preview");
    shareImages.push({ preset, theme, filename, bytes: bytes.length, ...imageData });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(await toggle.evaluate((button) => button === document.activeElement), "Share close must restore focus");
    await appearance(theme);
  }
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator('[data-preset="all"]').click();
    await ready();
    await appearance("light");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.locator("#addImportButton").click();
    await page.locator("#importDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Shift+Tab");
    assert.ok(await page.locator("#importDialog").evaluate((dialog) => dialog.contains(document.activeElement)));
    await page.keyboard.press("Escape");
    await page.locator("#importDialog").waitFor({ state: "hidden" });
    await page.locator("#updatePricingButton").click();
    const provider = page.locator("#pricingProviderList [data-pricing-provider]").first();
    await provider.waitFor({ state: "visible" });
    const providerId = await provider.getAttribute("data-pricing-provider");
    await provider.click();
    await page.locator("#providerPricingDialog").waitFor({ state: "visible" });
    await page.locator("#pricingModelList [data-pricing-model]").first().click();
    await page.locator("#modelPricingDialog").waitFor({ state: "visible" });
    assert.ok(await page.locator("#modelPricingFields input[data-model]").count());
    await page.keyboard.press("Escape");
    await page.locator("#modelPricingDialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator("#providerPricingDialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.pricingProvider), providerId);
    await page.keyboard.press("Escape");
    await page.locator("#pricingDialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "updatePricingButton");
    await shareImage("week", "light");
    for (const theme of ["dark", "light"]) {
      await page.locator("#themeToggle").click();
      await page.waitForFunction(
        (theme) =>
          document.documentElement.dataset.theme === theme &&
          !document.documentElement.hasAttribute("data-theme-transition") &&
          !document.querySelector("#themeToggle").disabled,
        theme,
      );
      await appearance(theme);
      await shareImage(theme === "dark" ? "month" : "today", theme);
    }
    if (edition === "waifu") {
      await page.locator("#skinToggle").click();
      await page.locator("#skinDialog").waitFor({ state: "visible" });
      assert.equal(await page.locator(".skin-card[data-skin-id]").count(), 10);
      await page.keyboard.press("Tab");
      assert.ok(await page.locator("#skinDialog").evaluate((dialog) => dialog.contains(document.activeElement)));
      await page.keyboard.press("Escape");
      await page.locator("#skinDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#skinToggle").getAttribute("aria-expanded"), "false");
    }
    await page.locator("#languageToggle").click();
    const switchedLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    assert.equal(await page.locator("html").getAttribute("lang"), switchedLocale);
    await appearance("light");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-preset="all"]').click();
    await ready();
    assert.equal(await page.locator("html").getAttribute("lang"), switchedLocale);
    await appearance("light");
    assert.deepEqual(errors, [], `Unexpected browser errors: ${JSON.stringify(errors)}`);
    return { locale, viewport, pricing: "passed", skinRequests: skinRequests.length, errors: errors.length, shareImages };
  } finally {
    await context.close();
  }
}

try {
  // Check both real archives before launching a browser, so an environment block still leaves HTTP evidence.
  for (const edition of ["standard", "waifu"]) {
    const variant = manifest.variants[edition];
    const expectedName = `${manifest.releaseVersion}${edition === "waifu" ? "-waifu" : ""}.zip`;
    assert.equal(variant.filename, expectedName);
    const zip = path.join(directory, expectedName);
    assert.equal(sha256(await readFile(zip)), variant.sha256);
    const unpacked = path.join(work, edition);
    await extractChecked(zip, unpacked, variant.files);
    await nativeCheck(unpacked);
    const packaged = JSON.parse(await readFile(path.join(unpacked, "package.json"), "utf8"));
    assert.equal(packaged.version, manifest.version);
    assert.equal(packaged.releaseVersion, manifest.releaseVersion);
    await exec(process.execPath, ["src/cli.js", "--help"], { cwd: unpacked });
  }
  for (const edition of ["standard", "waifu"]) {
    const fixture = await createPaletteFixture();
    let server;
    try {
      const { createUsageServer } = await import(pathToFileURL(path.join(work, edition, "src/server.js")).href);
      server = createUsageServer(createPaletteServerOptions(fixture));
      await listenOnFetchPort(server);
      const url = `http://127.0.0.1:${server.address().port}/`;
      const response = await fetch(`${url}api/usage?preset=all&view=dashboard`);
      assert.equal(response.status, 200);
      const { summary } = await response.json();
      assert.equal(summary.totals.total, FIXTURE_TOTAL_TOKENS);
      const html = await fetch(url).then((res) => res.text());
      assert.ok(html.includes(`data-edition="${edition}"`));
      const styles = await fetch(`${url}styles.css`);
      assert.equal(styles.status, 200);
      assert.equal(sha256(Buffer.from(await styles.arrayBuffer())), manifest.core["public/styles.css"]);
      assert.match(html, /id="shareToggle"/);
      assert.match(html, /id="shareDialog"/);
      for (const name of [
        "share-card.js", "share-card-data.js", "share-dialog.js", "share.css",
        "pricing-directory.js", "pricing-release-dates.js",
      ]) {
        const resource = await fetch(`${url}${name}`);
        assert.equal(resource.status, 200, `${edition} shared resource missing: ${name}`);
        assert.equal(sha256(Buffer.from(await resource.arrayBuffer())), manifest.core[`public/${name}`]);
      }
      const studio = await fetch(`${url}skin-palette-studio.html`);
      assert.equal(studio.status, edition === "waifu" ? 200 : 404);
      report.editions[edition] = {
        zipSha256: manifest.variants[edition].sha256,
        files: Object.keys(manifest.variants[edition].files).length,
        totals: summary.totals,
        statisticsSha256: sha256(
          JSON.stringify({
            totals: summary.totals,
            eventCount: summary.eventCount,
            sessionCount: summary.sessionCount,
            models: summary.models,
            channels: summary.channels,
            costEstimate: summary.costEstimate,
          }),
        ),
        browser: [],
      };
      if (browserRequested) {
        try {
          if (!browser) {
            const runtime = await resolveBrowserRuntime();
            assert.ok(runtime, "ENVIRONMENT_BLOCKED: Playwright/Edge unavailable");
            browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
          }
          for (const [locale, viewport] of [
            ["zh-CN", { width: 1440, height: 900 }],
            ["en-US", { width: 900, height: 900 }],
          ]) {
            report.editions[edition].browser.push(await checkPage(browser, url, edition, locale, viewport));
          }
        } catch (error) {
          report.browser = "failed-or-environment-blocked";
          report.browserError = error.stack;
          process.exitCode = 1;
        }
      }
    } finally {
      if (server?.listening) await server.close();
      await fixture.close();
    }
  }
  assert.deepEqual(report.editions.standard.totals, report.editions.waifu.totals, "Packaged core totals differ");
  assert.equal(
    report.editions.standard.statisticsSha256,
    report.editions.waifu.statisticsSha256,
    "Packaged models/channels/cost statistics differ",
  );
  if (browserRequested && !report.browserError) report.browser = "passed";
  report.checkedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, browserRequested ? "acceptance-browser.json" : "acceptance-http.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ...report, browserError: report.browserError?.split("\n")[0] }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    await removeTemporary(work, directory, ".check-");
  }
}
