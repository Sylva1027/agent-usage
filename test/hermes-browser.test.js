import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { resolveBrowserRuntime } from "../scripts/skin-palette/capture.mjs";

test("Hermes browser discovery, import, dashboard and share", { timeout: 90000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-browser-"));
  const db = new DatabaseSync(path.join(root, "state.db"));
  const now = Date.now() / 1000;
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL,
    last_activity_at REAL, input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT,
    billing_mode TEXT, task TEXT, input_tokens INTEGER, output_tokens INTEGER, first_seen REAL, last_seen REAL,
    PRIMARY KEY(session_id,model,billing_provider,billing_base_url,billing_mode,task));`);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)").run("s", "subagent", root, now, now, 100, 40);
  db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "s",
    "glm-5.1",
    "p",
    "",
    "api",
    "",
    100,
    40,
    now,
    now,
  );
  const server = createUsageServer({
    homeDir: root,
    env: { HERMES_HOME: root },
    extraHomes: "",
    importDirs: [],
    databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    pricingFetcher: async () => {
      throw new Error("Offline fixture");
    },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await listenOnFetchPort(server);
  const runtime = await resolveBrowserRuntime();
  if (!runtime) return t.skip("No local browser runtime");
  browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageLocale", "zh-CN");
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#addImportButton").click();
  await page.waitForSelector("#importCandidates input");
  assert.match(await page.locator("#importCandidates").innerText(), /Hermes/);
  await page.locator("#submitImportButton").click();
  await page.waitForFunction(() => /已导入 1 个来源/.test(document.querySelector("#importMessage").textContent));
  await page.locator("#cancelImportButton").click();
  await page.locator('[data-preset="all"]').click();
  await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
  await page.waitForFunction(() => document.querySelector("#totalTokens")?.textContent !== "—");
  const data = await page.evaluate(async () => {
    const { state } = await import("/app-state.js");
    return {
      eventCount: state.metadata.eventCount,
      harnessModels: state.metadata.harnessModels,
      total: state.summary.totals.total,
    };
  });
  assert.equal(data.eventCount, 1);
  assert.equal(data.total, 140);
  assert.deepEqual(data.harnessModels.Hermes, ["glm-5.1"]);
  await page.locator('[data-preset="today"]').click();
  await page.evaluate(async () => await (await import("/app.js")).activeUsageLoadDone);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 900, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator("#sourcePicker input[data-source-id]").count(), 1);
    assert.equal(await page.locator("#shareToggle").isEnabled(), true);
  }
  await page.locator("#shareToggle").click();
  await page.waitForFunction(() => !document.querySelector("#saveShareImage").disabled);
  assert.deepEqual(
    await page.locator("#shareImage").evaluate(async (image) => {
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }),
    [1080, 1440],
  );
  assert.deepEqual(errors, []);
});
