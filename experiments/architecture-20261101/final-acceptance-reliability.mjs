import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read-only identity observations; assertions and production return values stay intact.
const trace = process.env.FINAL_RELIABILITY_TRACE;
assert.ok(trace && path.isAbsolute(trace), "FINAL_RELIABILITY_TRACE must be an absolute evidence file");
const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = process.env.FINAL_RELIABILITY_RUNTIME || root;
globalThis.__finalReliabilityRecord = (kind, detail) => appendFileSync(trace,
  `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...detail })}\n`);

function replaceOnce(source, target, replacement) {
  assert.equal(source.split(target).length, 2, `identity probe target must occur once: ${target}`);
  return source.replace(target, replacement);
}

registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const relative = path.relative(root, file);
  const production = relative.startsWith(`src${path.sep}`) || relative.startsWith(`public${path.sep}`);
  let result = nextLoad(url, context);
  if (production && runtime !== root)
    result = { ...result, source: readFileSync(path.join(runtime, relative), "utf8") };
  if (relative === path.join("src", "server.js")) {
    result = { ...result, source: replaceOnce(String(result.source),
      "function usageVersion(fingerprint, source, catalog, asOf = new Date()) {",
      "function observedUsageVersion(fingerprint, source, catalog, asOf = new Date()) {") + `
function usageVersion(fingerprint, source, catalog, asOf = new Date()) {
  const value = observedUsageVersion(fingerprint, source, catalog, asOf);
  globalThis.__finalReliabilityRecord("identity", {
    value, fingerprint, routingFingerprint: source?.routingFingerprint,
    publication: source?.publication, certified: Boolean(source?.acquisition),
    pricing: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    asOf: asOf.toISOString(), stack: new Error().stack.split("\\n").slice(2, 4)
  });
  return value;
}
` };
  }
  if (relative === path.join("src", "usage-summary-cache.js")) {
    result = { ...result, source: String(result.source) + `
for (const name of ["readSourceState", "readCertifiedSourceState", "readPublication"]) {
  const original = UsageSummaryCache.prototype[name];
  UsageSummaryCache.prototype[name] = async function (...args) {
    const result = await original.apply(this, args);
    globalThis.__finalReliabilityRecord(name, {
      database: this.databaseFile, result,
      meta: name === "readPublication" && this.source
        ? this.source.prepare("SELECT key,value FROM store_meta ORDER BY key").all() : undefined
    });
    return result;
  };
}
` };
  }
  if (relative === path.join("test", "history-refresh-version.test.js")) {
    result = { ...result, source: replaceOnce(String(result.source),
      "async function serverFixture(t) {", `async function serverFixture(t) {
  globalThis.__finalReliabilityRecord("test", { name: t.name });`) };
  }
  return result;
} });
