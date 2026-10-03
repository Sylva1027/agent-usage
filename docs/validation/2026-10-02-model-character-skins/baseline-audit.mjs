// P0.2 classic-appearance baseline capture for the model character skin work.
//
// Captures the untouched "classic" dashboard (no skin code exists yet) across
// 7 widths x light/dark x zh-CN/en-US = 28 combinations, using a fully isolated
// synthetic fixture so no real usage data, logs or pricing files are read.
//
//   node docs/validation/2026-10-02-model-character-skins/baseline-audit.mjs
//   node docs/validation/2026-10-02-model-character-skins/baseline-audit.mjs --compare
//
// audit   -> writes baseline/geometry.json + baseline/screenshots/*
// compare -> re-captures with the same fixture and diffs against geometry.json,
//            writes baseline/compare-latest.json, exits 1 on any mismatch.
//
// This file is evidence tooling under docs/; it is not part of the shipped
// application and is outside the biome include set.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const output = path.dirname(fileURLToPath(import.meta.url));
const baselineDir = path.join(output, "baseline");
const screenshotsDir = path.join(baselineDir, "screenshots");
const geometryFile = path.join(baselineDir, "geometry.json");
const compareFile = path.join(baselineDir, "compare-latest.json");

const compareMode = process.argv.includes("--compare");
// --skins measures the same matrix with a character skin active, to prove the
// visible decoration layer does not compress or reflow the dashboard (P2.1).
const skinsMode = process.argv.includes("--skins");
const captureScreenshots = !compareMode;

const WIDTHS = [1920, 1680, 1440, 1280, 1024, 768, 390];
const THEMES = ["light", "dark"];
const LOCALES = ["zh-CN", "en-US"];
const FULL_PAGE_WIDTHS = [1920, 1440, 390];
const FULL_PAGE_LOCALE = "zh-CN";

const RECT_KEYS = ["x", "y", "width", "height", "right", "bottom"];
const RECT_TOLERANCE = 1; // CSS px, per implementation plan section 7.2
const OVERFLOW_TOLERANCE = 1;

const SELECTORS = {
  shell: ".shell",
  title: "h1",
  topbarActions: ".topbar-actions",
  languageToggle: "#languageToggle",
  themeToggle: "#themeToggle",
  toolbar: ".toolbar",
  rangeControls: ".range-controls",
  presetButtons: "#presetButtons",
  dateRangeControls: ".date-range-controls",
  dateRangeButton: "#dateRangeButton",
  autoRefreshStatus: "#autoRefreshStatus",
  autoRefreshWell: ".auto-refresh-well",
  metrics: "section.metrics:not(.price-metrics)",
  priceMetrics: ".price-metrics",
  comparisonSummary: "#comparisonSummary",
  mainGrid: ".main-grid",
  chartPanel: ".chart-panel",
  timelineChart: "#timelineChart",
  periodComparisonGrid: ".period-comparison-grid",
  modelComparisonTable: "#modelComparisonTable",
  repositoryComparisonTable: "#repositoryComparisonTable",
  bottomGrid: ".bottom-grid",
  homesPanel: ".homes-panel",
  pricingNotePanel: ".pricing-note-panel",
};

function viewportHeight(width) {
  return width === 390 ? 844 : 1080;
}

function keyOf(record) {
  return `${record.width}-${record.theme}-${record.locale}`;
}

async function loadPlaywright() {
  const candidates = [
    process.env.AGENT_USAGE_PLAYWRIGHT_MODULE,
    path.join(root, "node_modules/playwright/index.mjs"),
    path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"),
    path.join(os.homedir(), ".dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"),
  ].filter(Boolean);
  const attempts = [];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
    } catch {
      attempts.push(`${candidate} -> not found`);
      continue;
    }
    try {
      return { playwright: await import(pathToFileURL(candidate).href), source: candidate };
    } catch (error) {
      attempts.push(`${candidate} -> import failed: ${error.message}`);
    }
  }
  throw new Error(`Unable to load Playwright. Tried:\n${attempts.join("\n")}`);
}

async function launchBrowser(chromium) {
  const edgePath = process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const attempts = [];
  try {
    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    return { browser, command: `chromium.launch({ executablePath: ${JSON.stringify(edgePath)}, headless: true })` };
  } catch (error) {
    attempts.push(`edge ${edgePath} -> ${error.message}`);
  }
  try {
    const browser = await chromium.launch({ headless: true });
    return { browser, command: "chromium.launch({ headless: true })" };
  } catch (error) {
    attempts.push(`bundled chromium -> ${error.message}`);
  }
  throw new Error(`Unable to launch a browser.\n${attempts.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Isolated synthetic fixture
// ---------------------------------------------------------------------------

async function buildFixture(getDefaultPricingCatalog) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-usage-skin-baseline-"));
  const now = new Date();
  const sourceUrl = "https://models.dev/api.json";
  const defaults = getDefaultPricingCatalog();
  const model = "gpt-6.1-sol";
  const longModel = "research-model-with-a-very-long-experimental-name-2026-09-30-alpha-beta-gamma-delta-epsilon";

  const projects = [
    ["research-repository-with-a-very-long-name-中英文数字-20260930-alpha-beta-gamma", longModel, [1, 0, 0, 0]],
    ["Alpha-模型项目-2026", "gpt-6-sol", [100, 900, 0, 0]],
    ["Beta-陶瓷界面-2026", model, [100, 900, 100, 0]],
    ["Gamma-GLM-数据分析-2026", "glm-5.3", [100, 900, 100, 200]],
    ["Free-免费规则-2026", "mimo-v2.6-flash-free", [50, 0, 0, 0]],
    ["Retired-fixture-project", "retired-model-fixture", [0, 0, 0, 200]],
  ];

  const importDirs = [];
  let record = 0;
  for (const [name, modelName, quantities] of projects) {
    const cwd = path.join(fixture, name);
    importDirs.push(cwd);
    if (name.startsWith("research")) await mkdir(path.join(cwd, ".git"), { recursive: true });
    await mkdir(path.join(cwd, ".codex-usage"), { recursive: true });
    const rows = quantities.flatMap((quantity, index) => {
      if (!quantity) return [];
      const date = new Date(now);
      if (index === 0) date.setMinutes(date.getMinutes() - 5);
      if (index === 1) date.setDate(date.getDate() - 1);
      if (index === 2) date.setDate(date.getDate() - 8);
      if (index === 3) date.setDate(date.getDate() - 45);
      const total = quantity * 10_000;
      record += 1;
      return [
        {
          schema_version: "codex-usage.project-log.v1",
          timestamp: date.toISOString(),
          session_id: `baseline-session-${record}`,
          request_id: `baseline-request-${record}`,
          model: modelName,
          cwd,
          channel: name.startsWith("Alpha")
            ? "ZCode Subagent"
            : name.startsWith("Beta")
              ? "DSH Subagent"
              : name.startsWith("Gamma")
                ? "OpenCode"
                : "Codex Desktop",
          service_tier: modelName === model ? "priority" : "standard",
          usage: { total, input: total * 0.8, cached: total * 0.2, cache_write_input_tokens: total * 0.05, output: total * 0.2 },
        },
      ];
    });
    await writeFile(path.join(cwd, ".codex-usage/usage.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }

  const codex = path.join(fixture, ".codex/sessions");
  await mkdir(codex, { recursive: true });
  await writeFile(
    path.join(codex, "quota.jsonl"),
    [
      {
        timestamp: now.toISOString(),
        type: "session_meta",
        payload: { id: "baseline-quota", source: "cli", originator: "codex-tui", cwd: fixture },
      },
      {
        timestamp: now.toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
          },
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 10_800 },
            secondary: { used_percent: 20, window_minutes: 10_080, resets_at: Math.floor(now.getTime() / 1000) + 432_000 },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  for (const [source, quantity] of [
    ["cli", 50],
    ["exec", 80],
  ]) {
    const usage = { total_tokens: quantity, input_tokens: quantity - 10, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 };
    await writeFile(
      path.join(codex, `${source}-usage.jsonl`),
      [
        { timestamp: now.toISOString(), type: "session_meta", payload: { id: `baseline-${source}`, source, cwd: fixture } },
        { timestamp: now.toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
  }

  const pricingDir = path.join(fixture, ".codex-usage");
  await mkdir(pricingDir, { recursive: true });
  const metadata = (tier) => ({
    checkedAt: now.toISOString(),
    origin: tier === "short" ? "mixed" : "remote",
    sourceUrl,
    providerId: "openai",
    providedFields: tier === "short" ? ["input", "output"] : ["input", "cachedInput", "cacheWrite", "output"],
    inheritedFields: tier === "short" ? ["cachedInput", "cacheWrite"] : [],
    fieldSources: { input: sourceUrl, output: sourceUrl },
    ...(tier === "fast.long" ? { conflicts: [{ field: "input", sources: ["Models.dev", "LiteLLM"], values: [8, 9] }] } : {}),
  });
  await writeFile(
    path.join(pricingDir, "pricing-auto.json"),
    JSON.stringify({
      priceUpdatedAt: now.toISOString(),
      priceAttemptedAt: now.toISOString(),
      exchangeRateDate: now.toISOString().slice(0, 10),
      exchangeRateUpdatedAt: now.toISOString(),
      usdToCnyRate: 6.8,
      models: { [model]: { ...defaults.models[model], source: sourceUrl } },
      modelMetadata: { [model]: Object.fromEntries(["short", "long", "fast.short", "fast.long"].map((tier) => [tier, metadata(tier)])) },
      priceUpdateSummary: {
        attemptedModelCount: 82,
        verifiedModelCount: 1,
        changedModelCount: 0,
        partialModelCount: 1,
        conflictModelCount: 1,
        manualOverrideModelCount: 1,
        noValidMatchModelCount: 81,
        unsupportedCurrencyModelCount: 4,
      },
      issues: [],
    }),
  );
  await writeFile(
    path.join(pricingDir, "pricing.json"),
    JSON.stringify({ schemaVersion: 2, usdToCnyRate: 7.3, modelOverrides: { [model]: { short: { input: 2.2 } } } }),
  );

  const options = {
    homeDir: fixture,
    env: {},
    importDirs,
    importStoreFile: path.join(pricingDir, "imports.json"),
    databaseFile: path.join(pricingDir, "usage.sqlite"),
    automaticDiscoveryEnabled: false,
    pricingFetcher: async () => {
      throw new Error("Baseline fixture: simulated upstream unavailable");
    },
  };
  return { fixture, options, now };
}

// ---------------------------------------------------------------------------
// In-page measurement
// ---------------------------------------------------------------------------

// Runs in the browser: collects geometry, computed styles and track counts.
function measurePage(selectors) {
  const countTracks = (value) => {
    if (!value || value === "none") return 0;
    const cleaned = value.replace(/\[[^\]]*\]/g, " ").trim();
    if (!cleaned) return 0;
    const repeat = cleaned.match(/^repeat\(\s*(\d+)\s*,/);
    if (repeat) return Number(repeat[1]);
    return cleaned.split(/\s+/).filter(Boolean).length;
  };

  const rectOf = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
  };

  const rowGroups = (elements) => {
    const groups = new Map();
    for (const element of elements) groups.set(element.offsetTop, (groups.get(element.offsetTop) ?? 0) + 1);
    return [...groups.entries()].sort((left, right) => left[0] - right[0]).map(([, count]) => count);
  };

  const tableOf = (containerSelector) => {
    const table = document.querySelector(`${containerSelector} table`);
    if (!table) return null;
    const bodyRows = table.querySelectorAll("tbody tr");
    const firstRow = bodyRows[0];
    return {
      headColumns: table.querySelectorAll("thead th").length,
      rows: bodyRows.length,
      firstRowCells: firstRow ? firstRow.querySelectorAll(":scope > th, :scope > td").length : 0,
    };
  };

  const buttonOf = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      width: style.width,
      height: style.height,
      minHeight: style.minHeight,
      borderRadius: style.borderRadius,
      padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderTopWidth: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle,
      borderTopColor: style.borderTopColor,
      boxShadow: style.boxShadow,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      gap: style.gap,
    };
  };

  const rects = {};
  for (const [name, selector] of Object.entries(selectors)) rects[name] = rectOf(selector);

  const metricsGrid = document.querySelector("section.metrics:not(.price-metrics)");
  const priceMetricsGrid = document.querySelector(".price-metrics");

  return {
    rects,
    overflow: {
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    },
    grids: {
      metricsColumns: metricsGrid ? countTracks(getComputedStyle(metricsGrid).gridTemplateColumns) : null,
      metricsRows: metricsGrid ? rowGroups(metricsGrid.querySelectorAll("article.metric")) : null,
      priceMetricsColumns: priceMetricsGrid ? countTracks(getComputedStyle(priceMetricsGrid).gridTemplateColumns) : null,
      priceMetricsRows: priceMetricsGrid ? rowGroups(priceMetricsGrid.querySelectorAll("article.metric")) : null,
      mainGridColumns: countTracks(getComputedStyle(document.querySelector(".main-grid")).gridTemplateColumns),
      periodComparisonGridColumns: countTracks(getComputedStyle(document.querySelector(".period-comparison-grid")).gridTemplateColumns),
      toolbarRows: rowGroups(document.querySelectorAll(".toolbar > .control-group")),
      presetRows: rowGroups(document.querySelectorAll("#presetButtons > button, #presetButtons > .recent-segment")),
    },
    tables: {
      model: tableOf("#modelComparisonTable"),
      repository: tableOf("#repositoryComparisonTable"),
    },
    buttons: {
      languageToggle: buttonOf("#languageToggle"),
      themeToggle: buttonOf("#themeToggle"),
    },
    body: {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: getComputedStyle(document.body).fontSize,
    },
    html: {
      theme: document.documentElement.dataset.theme ?? null,
      locale: document.documentElement.dataset.locale ?? null,
      lang: document.documentElement.lang ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function ready(page) {
  await page.waitForFunction(
    () => document.querySelector("#totalTokens")?.textContent.trim() !== "-" && Boolean(document.querySelector("#modelComparisonTable table")),
  );
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

async function select(page, theme, locale) {
  if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
    await page.locator("#themeToggle").click();
  }
  const englishPressed = (await page.locator("#languageToggle").getAttribute("aria-pressed")) === "true";
  if (englishPressed !== (locale === "en-US")) {
    await page.locator("#languageToggle").click();
  }
  await settle(page);
}

/**
 * Optional P2 mode: turn characters on before measuring, so the same 28
 * combinations prove that visible artwork does not compress or reflow anything.
 * `--skins` uses the current mode's own files; `--skins-opacity` overrides the
 * default 50% to check the extreme case.
 */
async function activateSkins(page) {
  await page.waitForFunction(() => Boolean(window.__skinTestHook));
  await page.evaluate(() => window.__skinTestHook.selectSkin("chatgpt"));
  await page.waitForTimeout(450);
  const state = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    characters: document.getElementById("skinCharacters")?.dataset.skinCharacters,
    loaded: [...document.querySelectorAll("#skinCharacters img")].filter((image) => image.dataset.loaded === "1").length,
  }));
  assert.equal(state.skin, "chatgpt", "P2 mode must have an active character skin");
  assert.equal(state.characters, "on", "P2 mode must have characters enabled");
  assert.equal(state.loaded, 2, `P2 mode expected 2 decoded views, saw ${state.loaded}`);
  await settle(page);
}

function validateRecord(record) {
  const missing = Object.entries(record.rects)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  assert.deepEqual(missing, [], `${keyOf(record)}: missing measured elements -> ${missing.join(", ")}`);
  assert.ok(record.grids.metricsColumns !== null, `${keyOf(record)}: metrics grid missing`);
  assert.ok(record.tables.model !== null, `${keyOf(record)}: model comparison table missing`);
  assert.ok(record.tables.repository !== null, `${keyOf(record)}: repository comparison table missing`);
  assert.ok(record.buttons.languageToggle !== null, `${keyOf(record)}: languageToggle missing`);
  assert.ok(record.buttons.themeToggle !== null, `${keyOf(record)}: themeToggle missing`);
}

async function capture(browser, options, base, meta) {
  const records = [];
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: viewportHeight(width) },
      deviceScaleFactor: 1,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const label = `${width}px`;
    page.on("pageerror", (error) => pageErrors.push({ label, message: error.message }));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push({ label, message: message.text() });
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^https?:/u.test(url) && !url.startsWith(base)) {
        externalRequests.push(url);
        return route.abort();
      }
      return route.continue();
    });

    try {
      await page.goto(base, { waitUntil: "networkidle" });
      await ready(page);
      await page.locator('[data-preset="all"]').click();
      await settle(page);
      if (skinsMode) await activateSkins(page);

      for (const theme of THEMES) {
        for (const locale of LOCALES) {
          await select(page, theme, locale);
          await page.evaluate(() => window.scrollTo(0, 0));
          await settle(page);
          const measured = await page.evaluate(measurePage, SELECTORS);
          const record = { width, theme, locale, viewportHeight: viewportHeight(width), ...measured };
          validateRecord(record);
          records.push(record);
          console.log(`captured ${keyOf(record)}`);

          if (captureScreenshots) {
            const stem = `${width}-${theme}-${locale}`;
            await page.screenshot({ path: path.join(screenshotsDir, `${stem}-top.png`), fullPage: false });
            if (FULL_PAGE_WIDTHS.includes(width) && locale === FULL_PAGE_LOCALE) {
              await page.screenshot({ path: path.join(screenshotsDir, `${stem}-full.png`), fullPage: true });
            }
          }
        }
      }
    } finally {
      await context.close();
    }
  }

  return { records, pageErrors, consoleErrors, externalRequests, meta };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareRects(prefix, baseline, current, mismatches) {
  for (const name of Object.keys(baseline)) {
    const left = baseline[name];
    const right = current[name];
    if (left === null || right === null) {
      if (left !== right) mismatches.push({ key: `${prefix}.rects.${name}`, baseline: left, current: right, reason: "presence" });
      continue;
    }
    for (const axis of RECT_KEYS) {
      const delta = right[axis] - left[axis];
      if (Math.abs(delta) > RECT_TOLERANCE) {
        mismatches.push({ key: `${prefix}.rects.${name}.${axis}`, baseline: left[axis], current: right[axis], delta });
      }
    }
  }
}

function compareOverflow(prefix, baseline, current, mismatches) {
  for (const name of ["documentScrollWidth", "bodyScrollWidth"]) {
    const delta = current[name] - baseline[name];
    if (Math.abs(delta) > OVERFLOW_TOLERANCE) {
      mismatches.push({ key: `${prefix}.overflow.${name}`, baseline: baseline[name], current: current[name], delta });
    }
  }
}

function compareExact(prefix, baseline, current, mismatches) {
  if (JSON.stringify(baseline) !== JSON.stringify(current)) {
    mismatches.push({ key: prefix, baseline, current, reason: "exact" });
  }
}

function compareAll(baseline, current) {
  const mismatches = [];
  const baselineByKey = new Map(baseline.records.map((record) => [keyOf(record), record]));
  const currentByKey = new Map(current.records.map((record) => [keyOf(record), record]));

  for (const key of baselineByKey.keys()) {
    if (!currentByKey.has(key)) mismatches.push({ key, reason: "missing in current capture" });
  }
  for (const key of currentByKey.keys()) {
    if (!baselineByKey.has(key)) mismatches.push({ key, reason: "unexpected in current capture" });
  }

  for (const [key, expected] of baselineByKey) {
    const actual = currentByKey.get(key);
    if (!actual) continue;
    if (expected.viewportHeight !== actual.viewportHeight) {
      mismatches.push({ key: `${key}.viewportHeight`, baseline: expected.viewportHeight, current: actual.viewportHeight, reason: "exact" });
    }
    compareRects(key, expected.rects, actual.rects, mismatches);
    compareOverflow(key, expected.overflow, actual.overflow, mismatches);
    compareExact(`${key}.grids`, expected.grids, actual.grids, mismatches);
    compareExact(`${key}.tables`, expected.tables, actual.tables, mismatches);
    compareExact(`${key}.buttons`, expected.buttons, actual.buttons, mismatches);
    compareExact(`${key}.body`, expected.body, actual.body, mismatches);
    compareExact(`${key}.html`, expected.html, actual.html, mismatches);
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await mkdir(screenshotsDir, { recursive: true });

const { playwright, source: playwrightSource } = await loadPlaywright();
const { createUsageServer } = await import(pathToFileURL(path.join(root, "src/server.js")).href);
const { getDefaultPricingCatalog } = await import(pathToFileURL(path.join(root, "src/pricing.js")).href);

const { fixture, options, now } = await buildFixture(getDefaultPricingCatalog);
const server = createUsageServer(options);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const meta = {
  capturedAt: now.toISOString(),
  phase: compareMode ? "compare" : "audit",
  gitHead: (await readFile(path.join(root, ".git/HEAD"), "utf8")).trim(),
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  playwrightModule: playwrightSource,
  widths: WIDTHS,
  themes: THEMES,
  locales: LOCALES,
  combinations: WIDTHS.length * THEMES.length * LOCALES.length,
  fixture: "Synthetic project logs, synthetic pricing metadata, isolated home directory; no personal data",
  appState: 'Default dashboard, then the "all" range preset; locale/timezone fixed per context',
};

let browser;
let launchCommand = null;
let result;
try {
  const launched = await launchBrowser(playwright.chromium);
  browser = launched.browser;
  launchCommand = launched.command;
  meta.browser = await browser.version();
  meta.launchCommand = launchCommand;
  result = await capture(browser, options, base, meta);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const payload = {
  ...meta,
  playwrightModule: playwrightSource,
  records: result.records,
  pageErrors: result.pageErrors,
  consoleErrors: result.consoleErrors,
  externalRequests: result.externalRequests,
};

await mkdir(baselineDir, { recursive: true });

if (!compareMode) {
  await writeFile(geometryFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(root, geometryFile)} (${payload.records.length} combinations)`);
  console.log(`wrote ${path.relative(root, screenshotsDir)}/`);
  if (payload.pageErrors.length || payload.consoleErrors.length || payload.externalRequests.length) {
    console.log(`pageErrors=${payload.pageErrors.length} consoleErrors=${payload.consoleErrors.length} externalRequests=${payload.externalRequests.length}`);
  }
} else {
  const baseline = JSON.parse(await readFile(geometryFile, "utf8"));
  const mismatches = compareAll(baseline, payload);
  const report = {
    comparedAt: payload.capturedAt,
    baselineCapturedAt: baseline.capturedAt,
    combinations: payload.records.length,
    baselineCombinations: baseline.records.length,
    passed: mismatches.length === 0,
    mismatches,
  };
  await writeFile(compareFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\ncompared ${payload.records.length} combinations against ${path.relative(root, geometryFile)}`);
  if (mismatches.length === 0) {
    console.log("PASS no mismatches within tolerance");
  } else {
    console.log(`FAIL ${mismatches.length} mismatch(es); see ${path.relative(root, compareFile)}`);
    for (const mismatch of mismatches.slice(0, 40)) console.log(`  ${mismatch.key}: ${JSON.stringify(mismatch.baseline)} -> ${JSON.stringify(mismatch.current)}`);
    if (mismatches.length > 40) console.log(`  ... ${mismatches.length - 40} more`);
    process.exitCode = 1;
  }
}
