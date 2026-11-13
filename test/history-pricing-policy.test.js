import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { API_PRICING_VERSION, getPricingCatalog, runWithPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { readStoredAllSummary } from "../src/usage-all-summary-store.js";
import { buildStoredRecordChampions, readStoredRecordChampions } from "../src/usage-record-store.js";
import { summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { summaryCacheKey, UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createPricingPolicyFixture } from "../test-support/pricing-official-fixture.mjs";

for (const mode of ["hot", "mixed", "cold"]) {
  test(`pricing policies survive a process restart and obsolete dashboard caches: ${mode}`, async () => {
    const fixture = createPricingPolicyFixture();
    fixture.filters.now = new Date(fixture.filters.now);
    const catalog = getPricingCatalog();
    const store = new UsageStore(fixture.options);
    const cache = new UsageSummaryCache(fixture.options);
    let archiveFile;
    let archiveHash;
    try {
      const pricing = setPricingCatalog({ ...catalog, models: { ...catalog.models, ...fixture.models } });
      assert.notEqual(API_PRICING_VERSION, "2026-11-11");
      await store.sync();
      const report = await store.publishedHistoryUsageReport();
      const raw = report.events.map(({ model, total }) => ({ model, total }));
      const fresh = summarizeUsage(report, fixture.filters);
      assert.equal(fresh.totals.total, 1200);
      assert.equal(fresh.models.length, 2);
      assert.ok(Math.abs(fresh.costEstimate.totalUsd - 0.00216) < 1e-12);

      if (mode !== "hot") {
        const startMs = Date.parse("2026-07-11T00:00:00Z");
        const endMs = Date.parse(mode === "mixed" ? "2026-07-12T00:00:00Z" : "2026-07-13T00:00:00Z");
        archiveFile = path.join(fixture.options.homeDir, "cold.sqlite");
        await createHistoryArchiveCandidate(store.database, archiveFile, { startMs, endMs });
        const registered = await store.registerHistoryArchiveCandidate(archiveFile);
        store.database
          .prepare("INSERT INTO store_meta (key,value) VALUES (?,?)")
          .run(
            "history_archive_event_authority",
            JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
          );
        store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(endMs);
        store.commitStoreRevision("pricing-policy-fixture");
        assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, mode === "mixed" ? 3 : 0);
        archiveHash = createHash("sha256")
          .update(await readFile(archiveFile))
          .digest("hex");
      }

      const payload = await store.dashboardHistory(fixture.filters, { includeDetails: false });
      const oldPricing = { ...pricing, version: "2026-11-11" };
      const oldKey = summaryCacheKey(fixture.filters, false, oldPricing);
      const currentKey = summaryCacheKey(fixture.filters, false, pricing);
      assert.notEqual(oldKey, currentKey);
      const source = await cache.readSourceState();
      const oldPayload = structuredClone(payload);
      // Literal pre-R1 results; pricing algorithms stay in the production modules.
      oldPayload.summary.costEstimate.totalUsd = 0.0021600012;
      oldPayload.summary.models.find((row) => row.name === "hy4free").name = "workbuddy-ai/hy4free";
      oldPayload.pricingCatalog = oldPricing;
      await cache.publish(oldKey, oldPayload, {}, source, new Date(fixture.filters.now));
      const retained = await cache.get(oldKey, source, new Date(fixture.filters.now));
      if (mode === "hot") {
        assert.equal(retained.summary.costEstimate.totalUsd, 0.0021600012);
        assert.ok(retained.summary.models.some((row) => row.name === "workbuddy-ai/hy4free"));
      } else assert.equal(retained, null, "cold carriers retain their existing cache bypass");
      cache.close();
      store.close();

      const reopened = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import assert from "node:assert/strict";
        import { UsageStore } from "./src/usage-store.js";
        import { summaryCacheKey, UsageSummaryCache } from "./src/usage-summary-cache.js";
        import { setPricingCatalog } from "./src/pricing.js";
        const options = ${JSON.stringify(fixture.options)};
        const filters = ${JSON.stringify(fixture.filters)};
        filters.now = new Date(filters.now);
        const pricing = setPricingCatalog(${JSON.stringify(pricing)});
        const store = new UsageStore(options);
        const cache = new UsageSummaryCache(options);
        try {
          const source = await cache.readSourceState();
          const key = summaryCacheKey(filters, false, pricing);
          const now = new Date(filters.now);
          const retained = await cache.get(${JSON.stringify(oldKey)}, source, now);
          if (${JSON.stringify(mode)} === "hot") assert.equal(retained.summary.costEstimate.totalUsd, 0.0021600012);
          else assert.equal(retained, null);
          assert.equal(await cache.get(key, source, now), null);
          const payload = await store.dashboardHistory(filters, { includeDetails: false });
          await cache.publish(key, payload, {}, await cache.readSourceState(), now);
          assert.deepEqual(await cache.get(key, await cache.readSourceState(), now), ${JSON.stringify(mode)} === "hot" ? payload : null);
          const report = await store.publishedHistoryUsageReport();
          console.log(JSON.stringify({ payload, raw: report.events.map(({ model, total }) => ({ model, total })) }));
        } finally {
          cache.close();
          store.close();
        }
      `,
          ],
          { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      assert.deepEqual(reopened.raw, raw, "raw model IDs and token facts survive the policy change");
      const summary = reopened.payload.summary;
      assert.deepEqual(summary.totals, fresh.totals);
      assert.deepEqual(summary.models, fresh.models);
      assert.deepEqual(summary.costEstimate, fresh.costEstimate);
      assert.deepEqual(summary.timeline, fresh.timeline);
      assert.equal(reopened.payload.periodComparison.models.length, 2);
      assert.equal(
        reopened.payload.periodComparison.models.find((row) => row.name === "gemini-4-argon-contributor").periods.all
          .total,
        600,
      );
      for (const bucket of summary.timeline) {
        assert.equal(bucket.costByModel.hy4free.totalUsd, 0);
        assert.equal(bucket.costByModel.hy4free.minimumEstimatedTokens, 0);
        assert.equal(bucket.costByModel.hy4free.unpricedTokens, 0);
      }
      if (archiveFile) {
        assert.equal(
          createHash("sha256")
            .update(await readFile(archiveFile))
            .digest("hex"),
          archiveHash,
        );
      }
    } finally {
      cache.close();
      store.close();
      setPricingCatalog(catalog);
      fixture.close();
    }
  });
}

for (const mode of ["hot", "cold"]) {
  test(`fixed imported catalogs discard old calculation projections after reopen: ${mode}`, async () => {
    const fixture = createPricingPolicyFixture();
    fixture.filters.now = new Date(fixture.filters.now);
    const catalog = { ...getPricingCatalog(), version: "fixed-import-2026-11-11" };
    catalog.models = { ...catalog.models, ...fixture.models };
    const fixed = JSON.stringify(catalog);
    let store = new UsageStore(fixture.options);
    const withReader = (read) => (mode === "hot" ? read(store) : store.withSqlHistoryReader(read));
    const legacyKey = (key) => key.replace(`${API_PRICING_VERSION}:`, "");
    const byName = (rows) => [...rows].sort((left, right) => left.name.localeCompare(right.name));
    try {
      await runWithPricingCatalog(catalog, async () => {
        await store.sync();
        const report = await store.publishedHistoryUsageReport();
        const raw = JSON.stringify(report.events);
        const homes = structuredClone(store.homes);
        const evidence = {
          serviceTierEvidence: store.serviceTierEvidence,
          serviceTierEvidenceInput: store.serviceTierEvidenceInput,
          quotaSourceEvidence: store.quotaSourceEvidence,
        };
        const fresh = summarizeUsage(report, fixture.filters);
        if (mode === "cold") {
          const archive = path.join(fixture.options.homeDir, "fixed-cold.sqlite");
          await createHistoryArchiveCandidate(store.database, archive, {
            startMs: Date.parse("2026-07-11T00:00:00Z"),
            endMs: Date.parse("2026-07-13T00:00:00Z"),
          });
          const registered = await store.registerHistoryArchiveCandidate(archive);
          store.database
            .prepare("INSERT INTO store_meta (key,value) VALUES (?,?)")
            .run(
              "history_archive_event_authority",
              JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
            );
          store.database.exec("DELETE FROM events");
          store.commitStoreRevision("fixed-pricing-policy-fixture");
        }
        await withReader((reader) => {
          const records = reader.recordProjectionOptions("utc");
          const champions = buildStoredRecordChampions(records);
          champions.day.totalCost = { period: "2026-07-11", value: 99 };
          const table = reader.historyPersistentRead ? "usage_history_record_cache" : "usage_record_cache";
          reader.database
            .prepare(`UPDATE ${table} SET stable_key=?,champion_json=?`)
            .run(legacyKey(records.key), JSON.stringify(champions));
          reader.prepareAllSummaryProjection(fixture.filters, { includeDetails: false });
          const input = reader.allSummaryOptions(fixture.filters, { includeDetails: false });
          const prefix = reader.historyPersistentRead ? "usage_history_all_summary_" : "usage_all_summary_";
          reader.database.prepare(`UPDATE ${prefix}state SET context_key=?`).run(legacyKey(input.key));
          reader.database
            .prepare(`UPDATE ${prefix}checkpoints SET state_json=replace(state_json,?,?)`)
            .run('"hy4free"', '"workbuddy-ai/hy4free"');
        });
        store.close();
        store = new UsageStore(fixture.options);
        await store.open();
        store.homes = homes;
        Object.assign(store, evidence);
        await withReader((reader) => {
          const input = reader.allSummaryOptions(fixture.filters, { includeDetails: false });
          assert.equal(readStoredAllSummary(input), null, "fixed catalog versions cannot revive old model names");
          const records = reader.recordProjectionOptions("utc");
          assert.equal(
            readStoredRecordChampions(records),
            null,
            "old fee champions need the current calculation version",
          );
          reader.prepareAllSummaryProjection(fixture.filters, { includeDetails: false });
          const summary = reader.summarizeInReadTransaction(fixture.filters, { includeDetails: false });
          assert.deepEqual(byName(summary.models), byName(fresh.models));
          assert.deepEqual(summary.costEstimate, fresh.costEstimate);
          const rebuilt = buildStoredRecordChampions(records);
          assert.deepEqual(readStoredRecordChampions(records), rebuilt);
          assert.equal(
            rebuilt.day.totalCost,
            undefined,
            "equal daily costs cannot retain the old charged-route champion",
          );
        });
        assert.equal(JSON.stringify((await store.publishedHistoryUsageReport()).events), raw);
        assert.equal(JSON.stringify(catalog), fixed, "the imported catalog remains fixed");
      });
    } finally {
      store.close();
      fixture.close();
    }
  });
}
