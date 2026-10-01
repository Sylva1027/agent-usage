import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_PRICES_URL, modelsDevPricePatches } from "../../../src/pricing-auto.js";
import { ANTHROPIC_PRICING_SOURCE, getDefaultPricingCatalog } from "../../../src/pricing.js";

// Read public prices only. No local usage, model list or paths are sent upstream.
const response = await fetch(MODEL_PRICES_URL, { signal: AbortSignal.timeout(20_000) });
assert.equal(response.ok, true);
const payload = await response.json();
const catalog = getDefaultPricingCatalog();
const patches = modelsDevPricePatches(payload, catalog);
const rows = Object.entries(catalog.models).filter(([model]) => model.startsWith("claude-")).map(([model, entry]) => {
  const patch = patches[model];
  if (patch) {
    assert.equal(patch.__metadata.short.providerId, "anthropic");
    assert.deepEqual(patch.short, entry.short, model);
  }
  return { model, status: patch ? "matched-equal" : "no-valid-match-local-retained", builtin: entry.short, remote: patch?.short || null, provider: patch?.__metadata.short.providerId || null };
});
assert.ok(rows.some(row => row.status === "matched-equal"));
const result = { checkedAt: new Date().toISOString(), automaticSource: MODEL_PRICES_URL, officialSource: ANTHROPIC_PRICING_SOURCE, upstreamAnthropicIds: Object.keys(payload.anthropic?.models || {}), matched: rows.filter(row => row.status === "matched-equal").length, rows };
await writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "source-results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ selected: rows.length, matched: result.matched, retained: rows.length - result.matched }));
