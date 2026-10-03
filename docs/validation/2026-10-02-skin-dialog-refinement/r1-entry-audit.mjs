// R1 visual evidence. Run `node <this file> baseline` BEFORE the change,
// then `node <this file> verify`. Uses an isolated static fixture, never user data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const baselineMode = process.argv[2] === "baseline";
const widths = [1920, 1680, 1440, 1280, 1024, 768, 390];
const playwrightPath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(root, "public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${path.join(root, "public")}${path.sep}`)) return response.writeHead(404).end();
  try {
    const contents = readFileSync(file);
    response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    response.end(contents);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const observations = {};
const errors = [];
mkdirSync(output, { recursive: true });

function fileHashes(relativeDirectory, result = {}) {
  for (const entry of readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) fileHashes(relative, result);
    else result[relative] = createHash("sha256").update(readFileSync(path.join(root, relative))).digest("hex");
  }
  return result;
}

try {
  for (const theme of ["light", "dark"]) {
    for (const locale of ["zh-CN", "en-US"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
      await context.addInitScript(({ theme, locale }) => {
        localStorage.setItem("codexUsageTheme", theme);
        localStorage.setItem("codexUsageLocale", locale);
      }, { theme, locale });
      await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asOf: "2026-10-02T00:00:00.000Z", events: [], homes: [], sessions: [], rateLimitObservations: [] }) }));
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${theme}/${locale}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(60);
        const measurement = await page.evaluate(() => {
          const bounds = (node) => {
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          };
          const styleFor = (selector) => {
            const node = document.querySelector(selector);
            const s = getComputedStyle(node);
            return { ...bounds(node), background: s.backgroundImage, shadow: s.boxShadow, radius: s.borderRadius, border: s.borderTopColor };
          };
          const theme = document.documentElement.dataset.theme;
          const iconPaths = [...document.querySelectorAll("#skinToggle svg path")];
          return {
            geometry: [...document.querySelectorAll(".shell, .topbar, .topbar-actions, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric, .comparison-strip")].map((node) => ({ className: node.className, ...bounds(node) })),
            buttons: { skin: styleFor("#skinToggle"), language: styleFor("#languageToggle"), theme: styleFor("#themeToggle") },
            stroke: iconPaths.map((node) => getComputedStyle(node).stroke),
            opacity: getComputedStyle(document.querySelector("#skinToggle svg")).opacity,
            neighbourColor: getComputedStyle(document.querySelector("#languageToggle .language-divider")).color,
            neighbourStroke: getComputedStyle(document.querySelector(theme === "dark" ? "#themeToggle .theme-sun" : "#themeToggle .theme-moon")).stroke,
            classes: iconPaths.map((node) => node.getAttribute("class")),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            theme,
          };
        });
        assert.equal(measurement.theme, theme);
        const key = `${theme}/${locale}/${width}`;
        observations[key] = measurement;
        if (!baselineMode) {
          for (const stroke of measurement.stroke) {
            assert.equal(stroke, measurement.neighbourColor, `${key}: garment must match language neutral colour`);
            assert.equal(stroke, measurement.neighbourStroke, `${key}: garment must match inactive theme icon`);
          }
          assert.equal(measurement.opacity, "1", `${key}: no opacity dimming`);
          assert.deepEqual(measurement.classes, ["skin-icon-outline", "skin-icon-accent"]);
          assert.ok(measurement.overflow <= 1, `${key}: no horizontal overflow`);
          for (const property of ["width", "height", "background", "shadow", "radius", "border"]) {
            assert.equal(measurement.buttons.skin[property], measurement.buttons.language[property], `${key}: shared ${property}`);
          }
        }
        if (locale === "zh-CN" && [1440, 390].includes(width)) {
          await page.locator(".topbar").screenshot({ path: path.join(output, `${baselineMode ? "before" : "after"}-${theme}-${width}.png`) });
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const hashes = { ...fileHashes("public"), ...fileHashes("src"), ...fileHashes("lineart assets") };
const result = { stage: baselineMode ? "0-baseline" : "R1", recordedAt: new Date().toISOString(), observations, errors, hashes };
if (baselineMode) {
  result.head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  result.status = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" });
  result.diffStat = execFileSync("git", ["diff", "--numstat"], { cwd: root, encoding: "utf8" });
} else {
  const baseline = JSON.parse(readFileSync(path.join(output, "0-baseline.json"), "utf8"));
  for (const [key, measurement] of Object.entries(observations)) {
    assert.deepEqual(measurement.geometry, baseline.observations[key].geometry, `${key}: dashboard geometry changed`);
    assert.deepEqual(measurement.buttons, baseline.observations[key].buttons, `${key}: button geometry/material changed`);
  }
  assert.deepEqual(errors, baseline.errors, "new browser errors");
  for (const [file, hash] of Object.entries(baseline.hashes)) {
    if (!["public/index.html", "public/skins.css"].includes(file)) assert.equal(hashes[file], hash, `${file}: change beyond R1`);
  }
}
writeFileSync(path.join(output, baselineMode ? "0-baseline.json" : "r1-results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`${result.stage}: ${Object.keys(observations).length} viewport/theme/language cases; ${errors.length} browser errors; ${Object.keys(hashes).length} protected source/asset hashes.`);
console.log(JSON.stringify({ light: observations["light/zh-CN/1440"].stroke, dark: observations["dark/zh-CN/1440"].stroke }));
