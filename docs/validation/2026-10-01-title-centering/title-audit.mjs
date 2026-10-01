import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const live = process.argv.includes("--live");
const source = await readFile(path.join(root, "public/index.html"), "utf8");
const header = source.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
const css = await readFile(path.join(root, "public/styles.css"), "utf8");
const modulePath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const rows = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "reduce", locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  if (live) {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:3765") return route.abort();
      if (url.pathname === "/api/usage") url.searchParams.set("skipCheck", "1");
      return route.continue({ url: url.href });
    });
    await page.goto("http://127.0.0.1:3765", { waitUntil: "networkidle" });
  }
  for (const width of [1440, 1280, 1024, 390]) for (const theme of ["light", "dark"]) for (const font of ["default", "Segoe UI", "Arial"]) {
    await page.setViewportSize({ width, height: 1000 });
    if (live) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggle").click();
    } else {
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body><main class="shell">${header}</main></body></html>`);
    }
    await page.locator("h1").evaluate((node, font) => { node.style.visibility = "visible"; node.style.fontFamily = font === "default" ? "" : font; }, font);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const prefix = `${live ? "live-" : ""}header-${width}-${theme}-${font.replaceAll(" ", "-")}`;
    await page.locator(".topbar").screenshot({ path: path.join(output, `${prefix}-visible.png`), animations: "disabled" });
    const metrics = await page.evaluate(() => {
      const header = document.querySelector(".topbar").getBoundingClientRect();
      const title = document.querySelector("h1").getBoundingClientRect();
      const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
      const style = getComputedStyle(document.querySelector("h1"));
      return { header: header.toJSON(), title: title.toJSON(), actions: actions.toJSON(), fontSize: style.fontSize, transform: style.transform, trim: style.getPropertyValue("text-box-trim"), edge: style.getPropertyValue("text-box-edge"), compatMode: document.compatMode };
    });
    await page.locator("h1").evaluate(node => { node.style.visibility = "hidden"; });
    await page.locator(".topbar").screenshot({ path: path.join(output, `${prefix}-hidden.png`), animations: "disabled" });
    rows.push({ prefix, width, theme, font, ...metrics });
  }
  await writeFile(path.join(output, live ? "capture-live-final.json" : "capture-final.json"), JSON.stringify(rows, null, 2));
  await context.close();
} finally { await browser.close(); }
