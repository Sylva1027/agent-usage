import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { exportStaticDashboard, renderStaticDashboardHtml } from "../src/static-export.js";
import { getPricingCatalog, resetPricingCatalog } from "../src/pricing.js";

test("renderStaticDashboardHtml embeds usage data and app assets", () => {
  const html = renderStaticDashboardHtml({
    generatedAt: "2026-05-25T00:00:00.000Z",
    homes: [{ label: "Main Codex", path: "/tmp/.codex", kind: "main" }],
    sessions: [],
    events: [
      {
        timestamp: "2026-05-25T00:00:00.000Z",
        sessionId: "s1",
        channel: "CLI",
        cwd: "$&",
        model: "gpt-6-sol",
        detailMask: 15,
        total: { total: 10, input: 8, cached: 1, output: 2, reasoning: 0 },
      },
    ],
    warnings: [],
  });

  assert.match(html, /Agent Usage/);
  assert.match(html, /window.__CODEX_USAGE_REPORT__/);
  assert.ok(html.includes('"cwd":"$&"'));
  assert.match(html, /CLI/);
  assert.match(html, /timelineChart/);
  assert.match(html, /id="usageTooltip"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /themeToggle/);
  assert.match(html, /id="importButton"/);
  assert.match(html, /id="addImportButton"/);
  assert.match(html, /id="importDialog"/);
  assert.match(html, /id="importPath"/);
  assert.match(html, /id="pickImportDirectoryButton"/);
  assert.match(html, /id="comparisonSummary"/);
  assert.match(html, /id="totalCost"/);
  assert.match(html, /id="cacheHitRate"/);
  assert.match(html, /costEstimate/);
  assert.match(html, /<details id="costEstimateDetails" class="cost-estimate-details">/);
  assert.match(html, /id="updatePricingButton"/);
  assert.match(html, /id="pricingDialog"/);
  assert.ok(html.indexOf('id="homeList"') < html.indexOf('id="costEstimateDetails"'));
  assert.match(html, /#updatePricingButton \{[^}]*white-space: nowrap/s);
  assert.match(html, /按模型/);
  assert.match(html, /按仓库/);
  assert.doesNotMatch(html, /id="timelineDetails"/);
  assert.doesNotMatch(html, /id="projectList"/);
  assert.doesNotMatch(html, /id="modelList"/);
});

test("renderStaticDashboardHtml bundles shared timeline logic and has no unresolved imports", () => {
  const html = renderStaticDashboardHtml({ generatedAt: "2026-05-25T00:00:00.000Z", homes: [], sessions: [], events: [], warnings: [] });
  assert.match(html, /function buildTimelineRows/);
  assert.match(html, /id="autoRefreshToggle"/);
  assert.match(html, /id="timelineModes"/);
  assert.match(html, /id="languageToggle"/);
  assert.match(html, /codexUsageLocale/);
  assert.doesNotMatch(html, /import \{ buildTimelineRows \} from/);
  assert.doesNotMatch(html, /from "\.\/i18n\.js"/);
  const moduleSource = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(moduleSource);
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: moduleSource, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("static export freezes quota observations and capability at the export asOf", () => {
  const asOf = "2026-09-25T12:00:00.000Z";
  const report = {
    generatedAt: asOf,
    homes: [],
    sessions: [],
    events: [],
    rateLimitObservations: [{
      sourcePath: "codex.jsonl",
      lineNumber: 4,
      role: "primary",
      observedAtMs: Date.parse("2026-09-25T11:59:00.000Z"),
      limitId: "codex",
      limitName: null,
      planType: null,
      windowMinutes: 300,
      resetsAtMs: Date.parse("2026-09-25T14:37:00.000Z"),
      usedPercent: null,
    }],
    warnings: [],
  };
  const html = renderStaticDashboardHtml(report);
  const embedded = html.match(/window\.__CODEX_USAGE_REPORT__ = (.*?); window\.__CODEX_USAGE_PERIOD_COMPARISON__/s)?.[1];
  assert.ok(embedded);
  const snapshot = JSON.parse(embedded);

  assert.equal(snapshot.asOf, asOf);
  assert.equal(snapshot.generatedAt, asOf);
  assert.equal(snapshot.quota.asOf, asOf);
  assert.equal(snapshot.quota.windows.quota_5h.state, "available");
  assert.equal(snapshot.quota.windows.quota_5h.usedPercent, null);
  assert.equal(snapshot.quota.windows.quota_week.state, "missing");
  assert.equal(snapshot.rateLimitObservations.length, 1);
});

test("static export runs directly from a path containing spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex usage export "));
  const homeDir = path.join(root, "fake home");
  const outFile = path.join(root, "usage dashboard.html");
  await mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const scriptFile = path.join(projectRoot, "src", "static-export.js");
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    CODEX_USAGE_HOMES: "",
    CODEX_USAGE_IMPORT_DIRS: "",
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptFile, "--out", outFile], {
        cwd: projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /usage dashboard\.html/);
    const html = await readFile(outFile, "utf8");
    assert.match(html, /window.__CODEX_USAGE_REPORT__/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("static export applies saved pricing standards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-pricing-export-"));
  const pricingFile = path.join(root, "pricing.json");
  const outFile = path.join(root, "dashboard.html");
  const catalog = getPricingCatalog();
  catalog.checkedAt = "2026-09-24";
  catalog.models["gpt-6-sol"].short.output = 20;
  await writeFile(pricingFile, JSON.stringify(catalog));
  try {
    await exportStaticDashboard({ pricingFile, outFile, report: {
      generatedAt: "2026-05-25T00:00:00.000Z", homes: [], sessions: [], warnings: [],
      events: [{ timestamp: "2026-05-25T00:00:00.000Z", sessionId: "s1", channel: "CLI",
        model: "gpt-6-sol", detailMask: 7, cacheWriteKnown: true, cacheWriteTokens: 0,
        contextLevel: "short", serviceTier: "standard",
        total: { total: 10, input: 0, cached: 0, output: 10 } }],
    } });
    const html = await readFile(outFile, "utf8");
    assert.match(html, /"checkedAt":"2026-09-24"/);
    assert.match(html, /"outputUsd":0\.0002/);
  } finally {
    resetPricingCatalog();
    await rm(root, { recursive: true, force: true });
  }
});
