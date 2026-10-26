import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";

test("period facts survive rate and FX changes but follow model mapping and event changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "period-price-invalidation-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: root });
  const catalog = getPricingCatalog();
  const options = { now: new Date("2026-07-12T12:00:00Z"), calendarZone: "utc" };
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run("/fixture/a", "codex", "home-a", "Home A", "/fixture/home-a", 1, 1, "now");
    store.database
      .prepare(`INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning, detail_mask
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        "/fixture/a",
        Date.parse("2026-07-12T02:00:00Z"),
        "session-a",
        "home-a",
        "Home A",
        "CLI",
        "project-a",
        "Projection-Future-Model",
        "2026-07-12 02",
        "2026-07-12",
        "2026-07-06",
        "2026-07",
        100,
        80,
        0,
        20,
        0,
        31,
      );
    store.commitStoreRevision("fixture");
    let aggregateCalls = 0;
    const aggregate = store.periodAggregate;
    store.periodAggregate = function (...args) {
      aggregateCalls += 1;
      return aggregate.apply(this, args);
    };
    const before = store.periodComparison(options);
    const callsBeforeRates = aggregateCalls;
    assert.ok(callsBeforeRates > 0);
    const rates = structuredClone(catalog);
    rates.models["gpt-6-sol"].short.input *= 4;
    rates.usdToCnyRate *= 2;
    setPricingCatalog(rates);
    assert.deepEqual(store.periodComparison(options), before);
    assert.equal(aggregateCalls, callsBeforeRates, "rate and FX changes must not reaggregate period facts");

    rates.models["projection-future-model"] = structuredClone(rates.models["gpt-6-sol"]);
    setPricingCatalog(rates);
    const mapped = store.periodComparison(options);
    assert.ok(aggregateCalls > callsBeforeRates, "a new model mapping must invalidate period facts");
    assert.equal(before.models[0].name, "Projection-Future-Model");
    assert.equal(mapped.models[0].name, "projection-future-model");
    store.periodComparisonCache.clear();
    assert.deepEqual(store.periodComparison(options), mapped, "model remapping equals a fresh aggregation");

    const callsBeforeEvents = aggregateCalls;
    store.database.exec("UPDATE events SET total=200,input=160,output=40");
    store.commitStoreRevision("fixture-change");
    const changed = store.periodComparison(options);
    assert.ok(aggregateCalls > callsBeforeEvents);
    assert.equal(changed.totals.all.total, 200);
  } finally {
    store.close();
    setPricingCatalog(catalog);
    await rm(root, { recursive: true, force: true });
  }
});
