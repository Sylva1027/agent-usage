import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { normalizePerfSample, PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { getPricingCatalog, resetPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { checkpointUsageStore } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

// Authored without executing Node/SQLite; Main owns the serial runtime slot.
// Real executor scheduling, browser latency and Job peak memory remain Main's probes.
const NOW = "2026-07-12T12:00:00.000Z";
const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: NOW };
const DETAILS = { includeDetails: true };
const SOURCE_PATH = "/fixture/q3-usage.sqlite";
const EVENT_AUTHORITY = "history_archive_event_authority";
const PERF_AUTHORITY = "history_archive_perf_authority";

function copyContext(reader, source) {
  reader.homes = structuredClone(source.homes);
  reader.warnings = [...source.warnings];
  reader.generatedAt = source.generatedAt;
  reader.serviceTierEvidence = source.serviceTierEvidence;
  reader.serviceTierEvidenceInput = source.serviceTierEvidenceInput;
}

function pin(reader, source) {
  copyContext(reader, source);
  reader.database.exec("BEGIN");
  reader.database.prepare("SELECT id FROM events LIMIT 1").get();
}

function marker(database) {
  return database
    .prepare("SELECT key, value FROM store_meta WHERE key IN ('fingerprint','generated_at') ORDER BY key")
    .all();
}

function totalChanges(database) {
  return Number(database.prepare("SELECT total_changes() AS value").get().value);
}

function writeAuthority(database, key, value) {
  database.prepare("INSERT INTO store_meta(key,value) VALUES(?,?)").run(key, JSON.stringify(value));
}

function seed(source, root, empty) {
  const database = source.database;
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(SOURCE_PATH, "zcode", "home-a", "Home A", root, 1, 1, NOW);
    if (!empty) {
      const insert = database.prepare(`INSERT INTO events (
        source_path,timestamp_ms,session_id,home_id,home_label,channel,project,cwd,model,
        hour_key,day_key,week_key,month_key,detail_mask,cache_write_tokens,cache_write_known,
        request_input_tokens,context_level,service_tier,price_version,total,input,cached,output,reasoning
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [hour, total] of [
        ["02", 100],
        ["03", 200],
      ]) {
        insert.run(
          SOURCE_PATH,
          Date.parse(`2026-07-12T${hour}:00:00.000Z`),
          `q3-session-${hour}`,
          "home-a",
          "Home A",
          "ZCode",
          "q3-project",
          "/fixture/q3-project",
          "gpt-6-sol",
          `2026-07-12 ${hour}`,
          "2026-07-12",
          "2026-07-06",
          "2026-07",
          31,
          0,
          1,
          0,
          "short",
          "unknown",
          "q3-fixture",
          total,
          total * 0.8,
          0,
          total * 0.2,
          0,
        );
      }
      for (const [id, minute, outputTokens, durationMs] of [
        ["a", 10, 100, 1000],
        ["b", 20, 300, 2000],
      ]) {
        const tsMs = Date.parse(`2026-07-12T02:${minute}:00.000Z`);
        const normalized = normalizePerfSample({
          sourceKind: "zcode",
          identity: [`q3-${id}`],
          sourcePath: SOURCE_PATH,
          homeId: "home-a",
          channel: "zcode",
          agentKind: "unknown",
          agent: "",
          sessionId: `perf-${id}`,
          turnKey: "",
          model: "gpt-6-sol",
          modelProvider: "",
          reasoningEffort: "",
          modelEvidence: "",
          status: "completed",
          tsMs,
          windowStartMs: tsMs,
          windowEndMs: tsMs + durationMs,
          durationMs,
          outputTokens,
          requestCount: 1,
        });
        assert.ok(normalized.sample, JSON.stringify(normalized.warnings));
        source.insertPerfSample(normalized.sample);
      }
    }
    source.writePerfState("ready");
    source.writeMeta("perf_method_version", PERF_METHOD_VERSION);
    source.writeMeta("perf_index_version", "q3-perf-index");
    source.writeMeta("perf_indexed_at", NOW);
    source.writeMeta("fingerprint", "q3-baseline");
    source.writeMeta("generated_at", NOW);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  source.homes = [{ id: "home-a", label: "Home A", path: root, kind: "zcode" }];
  source.generatedAt = NOW;
  source.fingerprint = "q3-baseline";
  source.serviceTierEvidence = serviceTierEvidenceFromSnapshot({ formatVersion: 1, threads: [] });
  source.serviceTierEvidenceInput = "q3-empty-tier-evidence";
  source.commitStoreRevision("q3-fixture");
}

async function fixture(t, { empty = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "q3-published-projection-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const stores = [];
  const connections = [];
  t.after(async () => {
    resetPricingCatalog();
    let failure;
    for (const connection of [...connections, ...stores.map((store) => store.database)].reverse()) {
      if (!connection) continue;
      try {
        if (connection.isTransaction) connection.exec("ROLLBACK");
      } catch (error) {
        failure ??= error;
      }
    }
    for (const connection of connections) {
      try {
        connection.close();
      } catch (error) {
        failure ??= error;
      }
    }
    for (const store of stores.reverse()) {
      try {
        store.close();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  });
  async function open(file = databaseFile) {
    const store = new UsageStore({ homeDir: root, databaseFile: file, env: {}, importDirs: [] });
    stores.push(store);
    await store.open();
    return store;
  }
  const source = await open();
  const reader = await open();
  const oracle = await open();
  seed(source, root, empty);
  return {
    root,
    databaseFile,
    source,
    reader,
    oracle,
    open,
    external() {
      const database = new DatabaseSync(databaseFile);
      connections.push(database);
      return database;
    },
  };
}

function observe(store) {
  const counts = { timeline: 0, facts: 0, perf: 0, cost: 0 };
  const timeline = store.timelineRange;
  store.timelineRange = function (...args) {
    counts.timeline += 1;
    if (!args[2]?.factRows) counts.facts += 1;
    return timeline.apply(this, args);
  };
  const perf = store.perfSummaryForRange;
  store.perfSummaryForRange = function (...args) {
    counts.perf += 1;
    return perf.apply(this, args);
  };
  const cost = store.costEventsForRange;
  store.costEventsForRange = function (...args) {
    counts.cost += 1;
    return cost.apply(this, args);
  };
  return counts;
}

function changedCatalog() {
  const catalog = getPricingCatalog();
  for (const model of Object.values(catalog.models)) {
    for (const rates of [model.short, model.long, model.fast?.short, model.fast?.long].filter(Boolean)) {
      for (const field of ["input", "cachedInput", "cacheWrite", "output"]) rates[field] *= 3;
    }
  }
  return catalog;
}

test("Q3 same usage view adopts across unequal connection counters and rebuilds pinned perf", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  assert.equal(before.totals.total, 300);
  assert.equal(before.perf.groups[0].sums.outputTokens, 400);
  const sourceSlot = source.summaryProjectionCache;
  const sourceInputs = sourceSlot.quoteInputs;
  assert.ok(sourceInputs?.complete);
  assert.equal(sourceInputs.length, 2);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  source.database.exec("BEGIN IMMEDIATE");
  source.database.prepare("UPDATE perf_samples SET output_tokens=200 WHERE output_tokens=100").run();
  source.writeMeta("perf_indexed_at", "2026-07-12T12:01:00.000Z");
  source.database.exec("COMMIT");
  assert.notEqual(totalChanges(source.database), totalChanges(reader.database));
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  assert.notStrictEqual(reader.summaryProjectionCache, sourceSlot);
  assert.equal(reader.summaryProjectionCache.quoteInputs, null);
  assert.notEqual(reader.summaryProjectionCache.perfKey, sourceSlot.perfKey);
  const counts = observe(reader);
  const actual = await reader.summarizeHistory(FILTERS, DETAILS);
  const expected = await oracle.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(actual, expected);
  assert.equal(actual.perf.groups[0].sums.outputTokens, 500);
  assert.equal(actual.perf.groups[0].sums.durationMs, 3000);
  assert.equal(actual.perf.indexedAt, "2026-07-12T12:01:00.000Z");
  assert.equal(counts.timeline, 0, "accepted usage must avoid rebuilding the timeline");
  assert.equal(counts.cost, 0);
  assert.equal(counts.perf, 1, "the source perf cache must not be adopted");
  assert.strictEqual(source.summaryProjectionCache, sourceSlot);
  assert.strictEqual(source.summaryProjectionCache.quoteInputs, sourceInputs);
  assert.equal(sourceInputs.active, true);
});

test("Q3 adopted payload and public replies have independent nested ownership", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  const sourcePayload = source.summaryProjectionCache.projection;
  const targetPayload = reader.summaryProjectionCache.projection;
  assert.notStrictEqual(targetPayload, sourcePayload);
  assert.notStrictEqual(targetPayload.timeline, sourcePayload.timeline);
  assert.notStrictEqual(targetPayload.timeline[0].total, sourcePayload.timeline[0].total);
  assert.notStrictEqual(targetPayload.channels[0].total, sourcePayload.channels[0].total);
  assert.notStrictEqual(targetPayload.costEstimate, sourcePayload.costEstimate);
  const reply = await reader.summarizeHistory(FILTERS, DETAILS);
  reply.timeline[0].total.total = -1;
  reply.channels[0].total.total = -1;
  reply.costEstimate.totalUsd = -1;
  before.timeline[0].total.total = -2;
  assert.equal((await reader.summarizeHistory(FILTERS, DETAILS)).timeline[0].total.total, 300);
  assert.deepEqual(await source.summarizeHistory(FILTERS, DETAILS), await oracle.summarizeHistory(FILTERS, DETAILS));
});

test("Q3 empty events still pin a real read snapshot and can adopt an empty projection", async (t) => {
  const { source, reader, oracle } = await fixture(t, { empty: true });
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.database.isTransaction, true);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  const counts = observe(reader);
  const actual = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.equal(actual.totals.total, 0);
  assert.equal(actual.eventCount, 0);
  assert.deepEqual(actual.timeline, []);
  assert.deepEqual(actual, before);
  assert.deepEqual(actual, await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.equal(counts.timeline, 0);
  assert.equal(counts.perf, 1);
  assert.equal(reader.summaryProjectionCache.quoteInputs, null);
});

test("Q3 source transactions reject stale usage at build/capture, capture/pin and pin/adopt", async (t) => {
  for (const stage of ["before-capture", "before-pin", "after-pin"]) {
    await t.test(stage, async (t) => {
      const { source, reader } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = stage === "before-capture" ? null : source.captureUsageProjection();
      if (stage !== "before-capture") assert.ok(snapshot);
      if (stage === "after-pin") pin(reader, source);
      source.database.exec("BEGIN IMMEDIATE");
      source.writeTransactionDepth += 1;
      source.database.exec("UPDATE events SET total=total+7,input=input+7 WHERE total=100");
      source.database.exec("COMMIT");
      source.writeTransactionDepth -= 1;
      source.commitStoreRevision("q3-usage");
      if (stage === "before-capture") assert.equal(source.captureUsageProjection(), null);
      else {
        if (stage === "before-pin") pin(reader, source);
        assert.equal(reader.adoptUsageProjection(snapshot), false);
        assert.equal((await reader.summarizeHistory(FILTERS, DETAILS)).totals.total, stage === "after-pin" ? 300 : 307);
      }
      assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 307);
    });
  }
});

test("Q3 external commits with unchanged publication markers reject every unproved window", async (t) => {
  for (const stage of ["before-capture", "before-pin", "after-pin"]) {
    await t.test(stage, async (t) => {
      const { source, reader, external } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const published = marker(source.database);
      const snapshot = stage === "before-capture" ? null : source.captureUsageProjection();
      if (stage !== "before-capture") assert.ok(snapshot);
      if (stage === "after-pin") pin(reader, source);
      const database = external();
      database.exec("UPDATE events SET total=total+7,input=input+7 WHERE total=100");
      assert.deepEqual(marker(database), published);
      if (stage === "before-capture") assert.equal(source.captureUsageProjection(), null);
      else {
        if (stage === "before-pin") pin(reader, source);
        assert.equal(reader.adoptUsageProjection(snapshot), false);
        assert.equal((await reader.summarizeHistory(FILTERS, DETAILS)).totals.total, stage === "after-pin" ? 300 : 307);
      }
      assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 307);
      database.exec("UPDATE events SET total=total+11,input=input+11 WHERE total=107");
      assert.deepEqual(marker(database), published);
      assert.equal(source.captureUsageProjection(), null, "a second external commit cannot rebase the old slot");
      assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 318);
    });
  }
});

test("Q3 external perf-only commits still reject source certification", async (t) => {
  const { source, reader, external } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const published = marker(source.database);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  external().exec("UPDATE perf_samples SET output_tokens=200 WHERE output_tokens=100");
  pin(reader, source);
  assert.deepEqual(marker(source.database), published);
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  const actual = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.equal(actual.totals.total, 300);
  assert.equal(actual.perf.groups[0].sums.outputTokens, 500);
});

test("Q3 accepted reader keeps old usage and per-sample perf after source commits", async (t) => {
  const { source, reader } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  source.database.exec("BEGIN IMMEDIATE");
  source.database.exec("UPDATE events SET total=total+7,input=input+7 WHERE total=100");
  source.database.exec(`UPDATE perf_samples
    SET output_tokens=900,duration_ms=4000,window_end_ms=window_start_ms+4000
    WHERE output_tokens=100`);
  source.database.exec("COMMIT");
  source.commitStoreRevision("q3-usage-and-perf");
  const pinned = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(pinned, before);
  const samples = reader.database
    .prepare("SELECT output_tokens,duration_ms FROM perf_samples ORDER BY output_tokens")
    .all();
  assert.deepEqual(
    samples.map((row) => [row.output_tokens, row.duration_ms]),
    [
      [100, 1000],
      [300, 2000],
    ],
  );
  const live = await source.summarizeHistory(FILTERS, DETAILS);
  assert.equal(live.totals.total, 307);
  assert.equal(live.perf.groups[0].sums.outputTokens, 1200);
  assert.equal(live.perf.groups[0].sums.durationMs, 6000);
});

test("Q3 rejects a different physical DB even when databaseFile and markers are made identical", async (t) => {
  const f = await fixture(t);
  const other = await f.open(path.join(f.root, "other.sqlite"));
  seed(other, f.root, false);
  await f.source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = f.source.captureUsageProjection();
  assert.ok(snapshot);
  assert.deepEqual(marker(other.database), marker(f.source.database));
  const physicalFile = other.database
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main").file;
  assert.notEqual(path.resolve(physicalFile), path.resolve(f.source.databaseFile));
  other.databaseFile = f.source.databaseFile;
  pin(other, f.source);
  assert.equal(other.adoptUsageProjection(snapshot), false, "configured pathname cannot certify another open file");
  assert.equal(other.summaryProjectionCache, null);
});

test("Q3 source slot replacement, close and close/reopen invalidate captured references", async (t) => {
  for (const change of ["slot", "close", "reopen"]) {
    await t.test(change, async (t) => {
      const { source, reader } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = source.captureUsageProjection();
      assert.ok(snapshot);
      pin(reader, source);
      if (change === "slot") source.summaryProjectionCache = { ...source.summaryProjectionCache };
      else {
        source.close();
        if (change === "reopen") await source.open();
      }
      assert.equal(reader.adoptUsageProjection(snapshot), false);
      assert.equal((await reader.summarizeHistory(FILTERS, DETAILS)).totals.total, 300);
    });
  }
});

test("Q3 source raw writes without store revisions cannot certify an old slot", async (t) => {
  for (const sql of [
    "UPDATE events SET total=total+7,input=input+7 WHERE total=100",
    "UPDATE source_files SET kind='claude'",
    `INSERT INTO rate_limit_observations VALUES('${SOURCE_PATH}',1,'primary',${Date.parse(NOW)},'codex',NULL,NULL,300,${Date.parse(NOW) + 300000},25)`,
  ]) {
    await t.test(sql, async (t) => {
      const { source } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const revision = source.storeRevision;
      source.database.exec(sql);
      assert.equal(source.storeRevision, revision);
      assert.equal(source.captureUsageProjection(), null);
    });
  }
});

test("Q3 open transactions bypass capture and rollback never certifies uncommitted payload", async (t) => {
  for (const tracked of [false, true]) {
    await t.test(tracked ? "managed transaction" : "raw transaction", async (t) => {
      const { source, reader, oracle } = await fixture(t);
      const before = await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = source.captureUsageProjection();
      assert.ok(snapshot);
      source.database.exec("BEGIN IMMEDIATE");
      if (tracked) source.writeTransactionDepth += 1;
      source.database.exec("UPDATE events SET total=999,input=979 WHERE total=100");
      assert.equal(source.captureUsageProjection(), null);
      if (tracked) {
        const original = source.summaryProjectionCache;
        assert.equal(source.summarizeInReadTransaction(FILTERS, DETAILS).totals.total, 1199);
        assert.ok(source.summaryProjectionCache === original, "a managed write read must preserve the committed slot");
      }
      source.database.exec("ROLLBACK");
      if (tracked) source.rollbackReplaceFileTransaction();
      pin(reader, source);
      pin(oracle, source);
      assert.equal(
        reader.adoptUsageProjection(snapshot),
        false,
        "rollback may conservatively miss but must not rebase",
      );
      assert.deepEqual(await reader.summarizeHistory(FILTERS, DETAILS), before);
      assert.deepEqual(
        await source.summarizeHistory(FILTERS, DETAILS),
        await oracle.summarizeHistory(FILTERS, DETAILS),
      );
    });
  }
});

test("Q3 target requires a pinned read transaction and rejects managed writes or a closed DB", async (t) => {
  const { source, reader } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  copyContext(reader, source);
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  reader.database.exec("BEGIN IMMEDIATE");
  reader.writeTransactionDepth += 1;
  reader.database.prepare("SELECT id FROM events LIMIT 1").get();
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  reader.database.exec("ROLLBACK");
  reader.writeTransactionDepth -= 1;
  reader.close();
  assert.equal(reader.adoptUsageProjection(snapshot), false);
});

test("Q3 source context and recipient service-tier input must remain aligned", async (t) => {
  for (const change of ["source-homes", "source-tier", "reader-tier", "reader-homes"]) {
    await t.test(change, async (t) => {
      const { source, reader } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = source.captureUsageProjection();
      assert.ok(snapshot);
      pin(reader, source);
      if (change === "source-homes") source.homes[0].label = "Changed home";
      if (change === "source-tier") source.serviceTierEvidenceInput = "new-tier-signature";
      if (change === "reader-tier") reader.serviceTierEvidenceInput = "wrong-tier-signature";
      if (change === "reader-homes") reader.homes[0].label = "Wrong home";
      assert.equal(reader.adoptUsageProjection(snapshot), false);
      assert.equal(reader.summaryProjectionCache, null);
    });
  }
});

test("Q3 main and TEMP schema changes invalidate a captured guard without DML", async (t) => {
  for (const qualifier of ["", "TEMP "]) {
    await t.test(qualifier || "main", async (t) => {
      const { source, reader } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = source.captureUsageProjection();
      assert.ok(snapshot);
      const count = totalChanges(source.database);
      source.database.exec(`CREATE ${qualifier}TABLE q3_schema_probe(value INTEGER)`);
      source.database.exec("DROP TABLE q3_schema_probe");
      assert.equal(totalChanges(source.database), count, "DDL is invisible to raw row counters");
      pin(reader, source);
      assert.equal(reader.adoptUsageProjection(snapshot), false);
      assert.equal(source.captureUsageProjection(), null);
    });
  }
});

test("Q3 an unreadable source data_version cannot certify by returning an old observation", async (t) => {
  for (const stage of ["capture", "adopt"]) {
    await t.test(stage, async (t) => {
      const { source, reader } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = stage === "adopt" ? source.captureUsageProjection() : null;
      if (stage === "adopt") {
        assert.ok(snapshot);
        pin(reader, source);
      }
      const database = source.database;
      const prepare = database.prepare;
      database.prepare = function (sql, ...args) {
        if (/^\s*PRAGMA\s+(?:main\.)?data_version\s*;?\s*$/i.test(sql)) {
          throw new Error("q3 injected data_version read failure");
        }
        return prepare.call(this, sql, ...args);
      };
      try {
        if (stage === "capture") assert.equal(source.captureUsageProjection(), null);
        else assert.equal(reader.adoptUsageProjection(snapshot), false);
      } finally {
        database.prepare = prepare;
      }
      assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 300);
    });
  }
});

test("Q3 clone failure leaves source ownership intact and falls back to a complete target query", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const original = source.summaryProjectionCache;
  const inputs = original.quoteInputs;
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  pin(oracle, source);
  const clone = globalThis.structuredClone;
  const targetSlot = reader.summaryProjectionCache;
  globalThis.structuredClone = () => {
    throw new Error("q3 injected clone failure");
  };
  try {
    assert.equal(reader.adoptUsageProjection(snapshot), false);
  } finally {
    globalThis.structuredClone = clone;
  }
  assert.strictEqual(reader.summaryProjectionCache, targetSlot);
  assert.strictEqual(source.summaryProjectionCache, original);
  assert.strictEqual(source.summaryProjectionCache.quoteInputs, inputs);
  assert.equal(inputs.active, true);
  assert.deepEqual(await reader.summarizeHistory(FILTERS, DETAILS), await oracle.summarizeHistory(FILTERS, DETAILS));
});

test("Q3 target reprices by full SQL after source input discard and source close", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const inputs = source.summaryProjectionCache.quoteInputs;
  assert.ok(inputs?.complete);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  assert.equal(reader.summaryProjectionCache.quoteInputs, null);
  inputs.discard();
  source.close();
  const counts = observe(reader);
  const catalog = changedCatalog();
  setPricingCatalog(catalog);
  const repriced = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(repriced, await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.notEqual(repriced.costEstimate.totalUsd, before.costEstimate.totalUsd);
  assert.equal(repriced.totals.total, 300);
  assert.equal(counts.cost, 1, "no transferred quote buffer means complete SQL repricing");
  assert.equal(counts.facts, 0, "rate-only changes retain the adopted usage facts");
  assert.equal(reader.summaryProjectionCache.quoteInputs, null);
  catalog.usdToCnyRate *= 2;
  setPricingCatalog(catalog);
  oracle.summaryProjectionCache = null;
  const fx = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(fx, await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.equal(fx.costEstimate.totalUsd, repriced.costEstimate.totalUsd);
  assert.equal(fx.costEstimate.usdToCnyRate, catalog.usdToCnyRate);
  assert.equal(fx.costEstimate.totalCny, repriced.costEstimate.totalCny, "native CNY charges do not change with FX");
  assert.notEqual(
    fx.costEstimate.totalUsd * fx.costEstimate.usdToCnyRate,
    repriced.costEstimate.totalUsd * repriced.costEstimate.usdToCnyRate,
  );
  assert.equal(counts.cost, 2);
  assert.equal(inputs.active, false);
  assert.equal(inputs.length, 0);
});

test("Q3 target close cannot discard the source's independent complete quote input", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const inputs = source.summaryProjectionCache.quoteInputs;
  assert.ok(inputs?.complete);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  reader.database.exec("ROLLBACK");
  reader.close();
  assert.equal(inputs.active, true);
  assert.equal(inputs.length, 2);
  const counts = observe(source);
  setPricingCatalog(changedCatalog());
  copyContext(oracle, source);
  const actual = await source.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(actual, await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.equal(counts.cost, 0, "source retains its own complete repricing buffer");
  assert.equal(counts.facts, 0);
  assert.strictEqual(source.summaryProjectionCache.quoteInputs, inputs);
});

test("Q3 a price change before adoption cannot label old cost as the new catalog", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  setPricingCatalog(changedCatalog());
  pin(reader, source);
  pin(oracle, source);
  // Both conservative rejection and adoption with an old price identity are valid.
  assert.equal(typeof reader.adoptUsageProjection(snapshot), "boolean");
  const actual = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.deepEqual(actual, await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.notEqual(actual.costEstimate.totalUsd, before.costEstimate.totalUsd);
});

test("Q3 recipient request context still governs details, home exclusions, bucket and non-all reads", async (t) => {
  for (const [label, filters, options] of [
    ["details", FILTERS, { includeDetails: false }],
    ["exclude home", { ...FILTERS, excludeHomes: ["home-a", "home-a"] }, DETAILS],
    ["hour bucket", { ...FILTERS, bucket: "hour" }, DETAILS],
    ["local zone", { ...FILTERS, calendarZone: "local" }, DETAILS],
    ["today", { ...FILTERS, preset: "today", bucket: "hour" }, DETAILS],
  ]) {
    await t.test(label, async (t) => {
      const { source, reader, oracle } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      const snapshot = source.captureUsageProjection();
      assert.ok(snapshot);
      pin(reader, source);
      pin(oracle, source);
      assert.equal(reader.adoptUsageProjection(snapshot), true);
      const counts = observe(reader);
      const actual = await reader.summarizeHistory(filters, options);
      assert.deepEqual(actual, await oracle.summarizeHistory(filters, options));
      assert.ok(counts.timeline > 0, "a different request context must miss the transplanted slot");
      if (label === "details") assert.equal(actual.homes, undefined);
      if (label === "exclude home") {
        assert.equal(actual.totals.total, 0);
        assert.equal(actual.eventCount, 0);
      }
      assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 300);
    });
  }
});

test("Q3 advancing now with the same resolved all scope retains static facts", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  const counts = observe(reader);
  const filters = { ...FILTERS, now: new Date(Date.parse(NOW) + 1000).toISOString() };
  assert.deepEqual(await reader.summarizeHistory(filters, DETAILS), await oracle.summarizeHistory(filters, DETAILS));
  assert.equal(counts.timeline, 0);
});

test("Q3 actual event/perf authority rejects hot seeding and missing cold files remain errors", async (t) => {
  const { root, source, reader, oracle } = await fixture(t);
  const before = await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  const segmentFile = path.join(root, "cold.sqlite");
  await createHistoryArchiveCandidate(source.database, segmentFile, {
    startMs: Date.parse("2026-07-12T00:00:00.000Z"),
    endMs: Date.parse("2026-07-13T00:00:00.000Z"),
  });
  const registered = await source.registerHistoryArchiveCandidate(segmentFile);
  source.database.exec("BEGIN IMMEDIATE");
  try {
    writeAuthority(source.database, EVENT_AUTHORITY, { formatVersion: 1, segmentIds: [registered.segmentId] });
    writeAuthority(source.database, PERF_AUTHORITY, {
      formatVersion: 1,
      segments: [
        {
          segmentId: registered.segmentId,
          databaseSha256: registered.databaseSha256,
          sourceKinds: ["zcode"],
          methodVersions: [PERF_METHOD_VERSION],
        },
      ],
    });
    source.database.exec("DELETE FROM events");
    source.database.exec("DELETE FROM perf_samples");
    source.database.exec("COMMIT");
  } catch (error) {
    source.database.exec("ROLLBACK");
    throw error;
  }
  assert.equal(source.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assert.equal(source.captureUsageProjection(), null);
  pin(reader, source);
  pin(oracle, source);
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  const actual = await reader.summarizeHistory(FILTERS, DETAILS);
  assert.equal(actual.eventCount, 2);
  assert.equal(actual.totals.total, 300);
  assert.deepEqual(actual.totals, before.totals);
  assert.equal(actual.perf.groups[0].sums.outputTokens, 400);
  assert.deepEqual(actual, await oracle.summarizeHistory(FILTERS, DETAILS));
  await rename(segmentFile, `${segmentFile}.missing`);
  try {
    await assert.rejects(reader.summarizeHistory(FILTERS, DETAILS), /ENOENT/);
  } finally {
    await rename(`${segmentFile}.missing`, segmentFile);
  }
});

test("Q3 malformed perf-only authority is never bypassed by an adopted hot slot", async (t) => {
  const { source, reader } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  writeAuthority(source.database, PERF_AUTHORITY, { formatVersion: 1, segments: [] });
  assert.equal(source.captureUsageProjection(), null);
  pin(reader, source);
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  await assert.rejects(reader.summarizeHistory(FILTERS, DETAILS), { code: "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID" });
});

test("Q3 cold authority committed externally during open/pin rejects the old source guard", async (t) => {
  const { source, reader, external } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const published = marker(source.database);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  const database = external();
  writeAuthority(database, EVENT_AUTHORITY, { formatVersion: 1, segmentIds: ["a".repeat(64)] });
  pin(reader, source);
  assert.deepEqual(marker(database), published);
  assert.equal(reader.adoptUsageProjection(snapshot), false);
  await assert.rejects(reader.summarizeHistory(FILTERS, DETAILS), { code: "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND" });
});

test("Q3 no warmed slot falls back and released readers leave a successful checkpoint", async (t) => {
  const { source, reader } = await fixture(t);
  assert.equal(source.captureUsageProjection(), null);
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await reader.open();
    await source.summarizeHistory(FILTERS, DETAILS);
    const snapshot = source.captureUsageProjection();
    assert.ok(snapshot);
    pin(reader, source);
    assert.equal(reader.adoptUsageProjection(snapshot), true);
    source.database.exec("UPDATE events SET total=total+1,input=input+1 WHERE session_id='q3-session-02'");
    reader.database.exec("ROLLBACK");
    reader.close();
    const checkpoint = checkpointUsageStore(source.database);
    assert.equal(checkpoint.error, null);
    assert.equal(checkpoint.busy, 0);
    assert.equal(checkpoint.log, 0);
  }
});

test("Q3 context changed after building cannot be certified with a freshly rebased key", async (t) => {
  for (const change of ["home", "service-tier", "missing-context"]) {
    await t.test(change, async (t) => {
      const { source } = await fixture(t);
      await source.summarizeHistory(FILTERS, DETAILS);
      if (change === "home") source.homes[0].label = "New home label";
      if (change === "service-tier") source.serviceTierEvidenceInput = "changed-before-capture";
      if (change === "missing-context") source.summaryProjectionCache.context = null;
      assert.equal(source.captureUsageProjection(), null);
    });
  }
});

test("Q3 a resolver replacement cannot be certified by refreshing only perf", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  source.serviceTierEvidence = serviceTierEvidenceFromSnapshot({
    formatVersion: 1,
    threads: [{ threadId: "q3-session-02", turns: [{ time: 0, tier: "fast" }] }],
  });
  assert.equal(source.captureUsageProjection(), null);
  source.database.exec("UPDATE perf_samples SET output_tokens=output_tokens+1");
  const counts = observe(source);
  copyContext(oracle, source);
  const rebuilt = await source.summarizeHistory(FILTERS, DETAILS);
  assert.equal(counts.facts, 1, "changed resolver must rebuild usage before a new guard is issued");
  assert.deepEqual(rebuilt, await oracle.summarizeHistory(FILTERS, DETAILS));
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  assert.equal(reader.adoptUsageProjection(snapshot), true);
  assert.deepEqual(await reader.summarizeHistory(FILTERS, DETAILS), rebuilt);
});

test("Q3 equal evidence keeps its immutable resolver across real no-op syncs", async (t) => {
  const { source } = await fixture(t);
  await source.sync();
  await source.sync();
  await source.summarizeHistory(FILTERS, DETAILS);
  const resolver = source.serviceTierEvidence;
  for (let round = 0; round < 3; round += 1) {
    await source.sync();
    assert.ok(source.serviceTierEvidence === resolver, "unchanged evidence must retain resolver identity");
    assert.ok(source.captureUsageProjection(), "syncs without writer queries must not create a permanent miss");
  }
});

test("Q3 a raw target write transaction cannot accept the published payload", async (t) => {
  const { source, reader } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  const snapshot = source.captureUsageProjection();
  assert.ok(snapshot);
  pin(reader, source);
  reader.database.exec("UPDATE events SET total=999,input=979 WHERE total=100");
  assert.equal(reader.adoptUsageProjection(snapshot), false);
});

test("Q3 an untracked transaction read cannot become transferable after rollback", async (t) => {
  const { source, reader, oracle } = await fixture(t);
  await source.summarizeHistory(FILTERS, DETAILS);
  source.database.exec("BEGIN IMMEDIATE");
  source.database.exec("UPDATE events SET total=999,input=979 WHERE total=100");
  assert.equal((await source.summarizeHistory(FILTERS, DETAILS)).totals.total, 1199);
  source.database.exec("ROLLBACK");
  assert.equal(source.captureUsageProjection(), null, "unknown transaction payload must not gain a committed guard");
  const unsafeSlot = source.summaryProjectionCache;
  const counts = observe(source);
  source.database.exec("UPDATE perf_samples SET output_tokens=output_tokens+1");
  await source.summarizeHistory(FILTERS, DETAILS);
  assert.equal(counts.perf, 1, "the new perf payload must actually replace the slot");
  assert.ok(source.summaryProjectionCache !== unsafeSlot);
  assert.equal(source.captureUsageProjection(), null, "perf refresh cannot certify reused uncommitted facts");
  pin(reader, source);
  pin(oracle, source);
  assert.deepEqual(await reader.summarizeHistory(FILTERS, DETAILS), await oracle.summarizeHistory(FILTERS, DETAILS));
  assert.equal((await reader.summarizeHistory(FILTERS, DETAILS)).totals.total, 300);
});
