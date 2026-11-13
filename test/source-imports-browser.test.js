import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";
import { codexTokenLine } from "../test-support/codex-log-fixture.mjs";
import { SKIN_PREFERENCE_KEY } from "../public/skins.js";

test("source dialog scans without importing and only completes after the dashboard renders", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) return t.skip("No local browser runtime");
  const fixture = createCodexIntegrationFixture();
  await appendFile(fixture.rolloutFiles[0], `${codexTokenLine("2026-10-04T12:01:00Z", 100, 100)}\n`);
  const options = {
    ...fixture.serverOptions,
    extraHomes: "",
    env: { CODEX_HOME: fixture.codexHome },
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    pricingFetcher: async () => {
      throw new Error("Offline fixture");
    },
    pickDirectory: async () => fixture.codexHome,
  };
  const server = createUsageServer(options);
  let browser;
  const renderGate = Promise.withResolvers();
  t.after(async () => {
    renderGate.resolve();
    await browser?.close();
    await server.close();
    fixture.close();
  });
  await listenOnFetchPort(server);
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((key) => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    if (!localStorage.getItem("codexUsageLocale")) localStorage.setItem("codexUsageLocale", "zh-CN");
    localStorage.setItem("codexUsageTheme", "light");
    localStorage.setItem(key, JSON.stringify({ version: 1, skinId: "deepseek", showCharacters: true, opacity: 0.5 }));
  }, SKIN_PREFERENCE_KEY);
  const base = `http://127.0.0.1:${server.address().port}`;
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/usage?") && response.status() === 200),
    page.goto(base),
  ]);
  await page.locator("#addImportButton").click();
  await page.waitForSelector("#importCandidates input");
  assert.equal(await page.locator("#manualImportArea").isVisible(), false);
  assert.equal(await page.locator("#importCandidates input:checked").count(), 1);
  const manifest = () => readFile(options.importStoreFile, "utf8").then(JSON.parse);
  assert.deepEqual((await manifest()).imports, []);
  await mkdir("output/import-validation", { recursive: true });
  await page.locator("#importDialog .dialog").screenshot({ path: "output/import-validation/discovery-light.png" });

  await page.route("**/api/usage?**", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("freeze")) {
      await renderGate.promise;
    }
    await route.continue();
  });
  const usageRequested = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/usage" && !url.searchParams.has("freeze");
  });
  await page.locator("#submitImportButton").click();
  await page.waitForFunction(() => document.querySelector("#importMessage").textContent.includes("更新看板"));
  // The progress label updates before Playwright receives the request.
  await usageRequested;
  assert.equal(await page.locator("#submitImportButton").isDisabled(), true);
  assert.match(await page.locator("#importMessage").textContent(), /已用 \d+ 秒/);
  await page.locator("#cancelImportButton").click();
  await page.locator("#addImportButton").click();
  assert.match(await page.locator("#importMessage").textContent(), /更新看板/);
  renderGate.resolve();
  await page
    .waitForFunction(() => /已导入 1 个来源|暂无可统计记录/.test(document.querySelector("#importMessage").textContent))
    .catch(async (error) => {
      t.diagnostic(await page.locator("#importMessage").textContent());
      t.diagnostic(JSON.stringify(errors));
      throw error;
    });
  const rendered = await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    return { count: state.metadata.eventCount, snapshot: state.snapshotId, auto: state.autoRefreshEnabled };
  });
  assert.ok(rendered.count > 0);
  assert.equal(rendered.snapshot, null);
  assert.equal(rendered.auto, false);
  assert.equal((await manifest()).imports.length, 1);
  assert.equal(await page.locator("#sourcePicker input[data-source-id]").count(), 1);

  await page.locator("#rescanImportsButton").click();
  await page.waitForFunction(() => document.querySelector("#importMessage").textContent.includes("没有发现新的"));
  assert.equal(await page.locator("#manualImportArea").isVisible(), false);
  await page.locator("#manualImportButton").click();
  await page.locator("#pickImportDirectoryButton").click();
  await page.waitForFunction(() => document.querySelector("#importMessage").textContent.includes("已选择目录"));
  assert.equal(path.resolve(await page.locator("#importPath").inputValue()), path.resolve(fixture.codexHome));
  assert.equal((await manifest()).imports.length, 1, "the picker only returns a path");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#importDialog").isVisible(), false);
  assert.equal(await page.locator("#addImportButton").evaluate((element) => element === document.activeElement), true);

  await page.route("**/api/imports/discover", (route) =>
    route.fulfill({ json: { candidates: [], errors: [{ path: "C:\\records", code: "EACCES" }], platform: "win32" } }),
  );
  await page.evaluate(() => localStorage.setItem("codexUsageLocale", "en-US"));
  await page.reload();
  await page.locator("#addImportButton").click();
  await page.waitForSelector("#manualImportArea:visible");
  assert.match(await page.locator("#importMessage").textContent(), /could not be accessed/);
  await page.locator(".import-help summary").first().click();
  assert.match(await page.locator("#importHelp").textContent(), /File Explorer/);
  assert.equal(await page.locator("#submitImportButton").isDisabled(), true);
  assert.deepEqual(errors, []);
});
