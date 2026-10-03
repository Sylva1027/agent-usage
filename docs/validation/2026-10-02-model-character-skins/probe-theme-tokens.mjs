// Probe: what do the theme variables resolve to in each context?
// Establishes the ground truth that the preview scoping must reproduce.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webp": "image/webp" };
const server = createServer((q, s) => {
  const u = new URL(q.url, "http://x");
  const fp = path.join(root, "public", u.pathname === "/" ? "index.html" : u.pathname);
  try { const b = readFileSync(fp); s.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" }); s.end(b); }
  catch { s.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pw = path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(pw).href);
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asOf: new Date().toISOString(), events: [], homes: [], sessions: [], rateLimitObservations: [] }) }));
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
await page.waitForTimeout(400);

const TOKENS = ["--bg", "--panel", "--control", "--track", "--neo-surface", "--neo-glow", "--neo-edge", "--ceramic-top", "--ceramic-bottom", "--ceramic-well", "--ceramic-light", "--ceramic-shade", "--ceramic-rim", "--ink", "--muted", "--line", "--blue", "--record", "--chart-text", "--chart-line", "--neo-raised", "--neo-raised-small", "--neo-inset", "--neo-inset-small", "--dialog-shadow", "--shadow", "--active-ink", "--green", "--gold", "--red", "--control-hover"];

async function readTokens() {
  return page.evaluate((tokens) => {
    const probe = document.createElement("div");
    // Measure off the live body background as a second opinion.
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const out = {};
    for (const token of tokens) out[token] = style.getPropertyValue(token).trim();
    probe.remove();
    return { tokens: out, bodyBg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme };
  }, TOKENS);
}

const light = await readTokens();
await page.locator("#themeToggle").click();
await page.waitForTimeout(300);
const dark = await readTokens();

console.log("=== LIGHT (root theme=light) ===");
console.log(JSON.stringify(light, null, 1));
console.log("\n=== DARK (root theme=dark) ===");
console.log(JSON.stringify(dark, null, 1));

// Which tokens actually differ between modes tells us what a preview must override.
const differing = TOKENS.filter((t) => light.tokens[t] !== dark.tokens[t]);
const identical = TOKENS.filter((t) => light.tokens[t] === dark.tokens[t]);
console.log("\n=== tokens that DIFFER by mode (must be scoped) ===");
for (const t of differing) console.log(`  ${t}: ${light.tokens[t]} -> ${dark.tokens[t]}`);
console.log("\n=== tokens IDENTICAL in both modes (inherit safely) ===");
console.log("  " + identical.join(", "));

await browser.close();
server.close();
