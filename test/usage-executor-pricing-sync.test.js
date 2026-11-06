import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createRemainingHarnessFixture, insertDatabaseEvent } from "../test-support/remaining-harness-fixture.mjs";

const filters = { preset: "all", calendarZone: "utc", bucket: "day" };
function database(file, operation) {
  const db = new DatabaseSync(file);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
async function fixture(t, { pause = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "executor-pricing-sync-"));
  const original = getPricingCatalog(),
    argv = [...process.execArgv];
  const home = path.join(root, ".zcode"),
    directory = path.join(home, "cli", "db");
  const input = createRemainingHarnessFixture(directory, "zcode", 3);
  const sourceFile = path.join(directory, "db.sqlite");
  renameSync(input.filePath, sourceFile);
  const options = {
    homeDir: root,
    env: {},
    importDirs: [home],
    databaseFile: path.join(root, "index.sqlite"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  let catalog = setPricingCatalog({ ...original, checkedAt: "2026-11-06", usdToCnyRate: 7.123 });
  const clients = [];
  const marker = (name) => path.join(root, name);
  if (pause) {
    const hook = `import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){
      const result=next(url,ctx);if(!url.endsWith('/src/usage-store.js'))return result;
      return {...result,source:result.source+${JSON.stringify(`
        import {existsSync as pricingGateExists,writeFileSync as pricingGateWrite} from 'node:fs';
        const pricingSyncReplace=UsageStore.prototype.replaceFile;
        UsageStore.prototype.replaceFile=async function(file,...args){
          if(file.source.kind==='zcode'&&pricingGateExists(${JSON.stringify(marker("gate"))})){
            pricingGateWrite(${JSON.stringify(marker("entered"))},'ready');
            const deadline=Date.now()+30000;
            while(!pricingGateExists(${JSON.stringify(marker("release"))})){
              if(Date.now()>deadline)throw new Error('pricing sync gate timed out');
              await new Promise(resolve=>setTimeout(resolve,10));
            }
          }
          return pricingSyncReplace.call(this,file,...args);
        };
      `)}};}});`;
    process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(hook)}`);
  }
  t.after(async () => {
    writeFileSync(marker("release"), "release");
    for (const client of clients) await client.close();
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    setPricingCatalog(original);
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const client = createUsageExecutor(options, { pricing: () => catalog, idleTimeoutMs: 60_000 });
    clients.push(client);
    return client;
  };
  const rows = () => database(options.databaseFile, (db) => db.prepare("SELECT * FROM events ORDER BY id").all());
  const revision = () =>
    database(options.databaseFile, (db) => db.prepare("SELECT revision FROM usage_business_revision").get().revision);
  return {
    open,
    options,
    rows,
    revision,
    marker,
    append: (index) => database(sourceFile, (db) => insertDatabaseEvent(db, "zcode", index)),
    get catalog() {
      return catalog;
    },
    reprice: () => (catalog = setPricingCatalog({ ...catalog, usdToCnyRate: 8.123 })),
  };
}

test("sync records the authoritative pricing version before queries, on warm reuse, and after restart", async (t) => {
  const f = await fixture(t);
  let client = f.open();
  await client.sync({ options: f.options });
  const initial = f.rows();
  assert.equal(initial.length, 3);
  assert.deepEqual([...new Set(initial.map((row) => row.price_version))], [f.catalog.version]);
  await client.dashboard(filters, { includeDetails: false });
  let before = f.revision();
  f.append(3);
  await client.sync({ options: f.options });
  assert.deepEqual(f.rows().slice(0, 3), initial);
  assert.equal(f.revision() - before, 1, "warm append must only insert its new fact");
  await client.close();
  client = f.open();
  before = f.revision();
  f.append(4);
  await client.sync({ options: f.options });
  assert.equal(f.revision() - before, 1, "restart cannot change the parser catalog");
  assert.ok(f.rows().every((row) => row.price_version === f.catalog.version));
  f.reprice();
  f.append(5);
  before = f.revision();
  await client.sync({ options: f.options });
  assert.equal(f.revision() - before, 11, "a real version change retains full-replacement semantics");
  assert.ok(f.rows().every((row) => row.price_version === f.catalog.version));
});

test("a concurrent dashboard catalog cannot change the catalog captured by an awaiting sync", async (t) => {
  const f = await fixture(t, { pause: true });
  const client = f.open();
  await client.sync({ options: f.options });
  const captured = f.catalog.version;
  f.append(3);
  writeFileSync(f.marker("gate"), "pause");
  const before = f.revision(),
    pending = client.sync({ options: f.options });
  const deadline = Date.now() + 30_000;
  try {
    while (!existsSync(f.marker("entered"))) {
      assert.ok(Date.now() < deadline, "sync never reached its source parser");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(f.marker("entered"), "utf8"), "ready");
    f.reprice();
    const response = await client.dashboard(filters, { includeDetails: false });
    assert.equal(response.summary.eventCount, 3, "the concurrent reader sees the committed version");
    assert.equal(response.summary.costEstimate.usdToCnyRate, 8.123);
  } finally {
    writeFileSync(f.marker("release"), "release");
    await pending;
  }
  assert.deepEqual([...new Set(f.rows().map((row) => row.price_version))], [captured]);
  assert.equal(f.revision() - before, 1);
});
