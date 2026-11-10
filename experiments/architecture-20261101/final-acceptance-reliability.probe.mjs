import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createUsageServer } from "../../src/server.js";
import { getPricingCatalog, setPricingCatalog } from "../../src/pricing.js";
import { createCodexIntegrationFixture } from "../../test-support/usage-fixture.mjs";

const destination = process.argv[2];
assert.ok(destination && path.isAbsolute(destination), "pass an absolute private evidence path");
const fixture = createCodexIntegrationFixture();
const catalog = getPricingCatalog();
const server = createUsageServer(fixture.serverOptions);
const checks = [];
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = "/api/usage?preset=all&view=dashboard&bucket=hour&calendarZone=local";
  async function get(url = query) {
    const response = await fetch(base + url);
    const result = await response.json();
    assert.equal(response.status, 200);
    return result;
  }
  function check(name, actual, expected) {
    checks.push({ name, actual, expected, passed: actual === expected });
  }
  await appendFile(fixture.rolloutFiles[0], `${JSON.stringify({ type: "event_msg",
    timestamp: "2026-10-04T13:00:00Z",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: 100, input_tokens: 100 } } }
  })}\n`);
  await get();
  await get();
  const initial = await get();
  check("initial API/status identity", initial.usageVersion, (await get("/api/status")).usageVersion);
  const writer = new DatabaseSync(fixture.serverOptions.databaseFile);
  try { writer.exec("UPDATE events SET total=total+50,input=input+50"); }
  finally { writer.close(); }
  const external = await get("/api/status");
  check("external correction invalidates identity", external.usageVersion !== initial.usageVersion, true);
  await get();
  const corrected = await get();
  check("external correction changes totals", corrected.summary.totals.total, 150);
  check("corrected API/status identity", corrected.usageVersion, (await get("/api/status")).usageVersion);
  setPricingCatalog({ ...getPricingCatalog(), usdToCnyRate: 7.123456 });
  const priced = await get("/api/status");
  check("repricing invalidates identity", priced.usageVersion !== corrected.usageVersion, true);
  check("repriced API/status identity", (await get()).usageVersion, priced.usageVersion);
  await writeFile(path.join(fixture.codexHome, "config.toml"), 'model_provider = "api"\n');
  const evidence = await get("/api/status");
  check("evidence change invalidates identity", evidence.usageVersion !== priced.usageVersion, true);
  await get();
  check("evidence API/status identity (original line 267)",
    (await get()).usageVersion, (await get("/api/status")).usageVersion);
} finally {
  await server.close();
  setPricingCatalog(catalog);
  fixture.close();
  await writeFile(destination, `${JSON.stringify({ checks, passed: checks.length === 8 && checks.every(c => c.passed) }, null, 2)}\n`);
}
assert.equal(checks.length, 8);
assert.deepEqual(checks.filter(c => !c.passed), [], "every identity assertion remains required");
