import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizePerfSample, PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const NOW = "2026-10-04T13:00:00.000Z";
const LATER = "2026-10-04T13:05:00.000Z";
const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: NOW };

function insert(database, table, row) {
  const columns = Object.keys(row);
  database
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function event(sourcePath, overrides = {}) {
  return {
    source_path: sourcePath,
    timestamp_ms: Date.parse("2026-10-04T12:01:00.000Z"),
    session_id: "q2-session-a",
    home_id: "home-a",
    home_label: "Home A",
    channel: "CLI",
    project: "/work/a",
    model: "gpt-6-sol",
    hour_key: "2026-10-04 12",
    day_key: "2026-10-04",
    week_key: "2026-09-28",
    month_key: "2026-10",
    detail_mask: 31,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: 0,
    context_level: "short",
    service_tier: "unknown",
    price_version: "q2-fixture",
    total: 100,
    input: 80,
    cached: 0,
    output: 20,
    reasoning: 0,
    ...overrides,
  };
}

function observation(sourcePath, overrides = {}) {
  return {
    source_path: sourcePath,
    line_number: 1,
    role: "primary",
    observed_at_ms: Date.parse("2026-10-04T12:00:00.000Z"),
    limit_id: "codex",
    window_minutes: 300,
    resets_at_ms: Date.parse("2026-10-04T17:00:00.000Z"),
    used_percent: 25,
    ...overrides,
  };
}

function countAllTimelines(store) {
  let calls = 0;
  const timelineRange = store.timelineRange;
  store.timelineRange = function (range, ...args) {
    if (range.preset === "all") calls += 1;
    return timelineRange.call(this, range, ...args);
  };
  return () => calls;
}

function components(store, inTransaction = false, filters = FILTERS) {
  // Read the independent caches first; summary must not repair them before the assertions.
  const metadata = store.metadata(new Date(filters.now));
  const periodComparison = store.periodComparison(filters);
  const observations = store.quotaObservations();
  const summarize = inTransaction
    ? (scope) => store.summarizeInReadTransaction(scope)
    : (scope) => store.summarize(scope);
  const summary = summarize(filters);
  const quotaFilters = { ...filters, preset: "quota_5h", bucket: "quota_30m" };
  let quotaSummary = null;
  if (summary.quota.windows.quota_5h.state === "available") quotaSummary = summarize(quotaFilters);
  else assert.throws(() => summarize(quotaFilters), { code: "QUOTA_WINDOW_UNAVAILABLE" });
  return structuredClone({
    metadata,
    periodComparison,
    observations,
    summary,
    quotaSummary,
  });
}

async function assertFresh(store, label, filters = FILTERS) {
  const actual = components(store, false, filters);
  const referenceFile = path.join(path.dirname(store.databaseFile), "q2-fresh-reference.sqlite");
  const reference = new UsageStore({ databaseFile: referenceFile });
  try {
    // A fresh connection to a separate committed backup cannot inherit any warmed derived slot.
    await backup(store.database, referenceFile);
    await reference.open();
    reference.homes = structuredClone(store.homes);
    reference.warnings = [...store.warnings];
    reference.serviceTierEvidence = store.serviceTierEvidence;
    assert.deepEqual(actual, components(reference, false, filters), label);
    return actual;
  } finally {
    reference.close();
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${referenceFile}${suffix}`, { force: true });
  }
}

async function withStore(run) {
  const root = await mkdtemp(path.join(tmpdir(), "q2-usage-projection-"));
  const store = new UsageStore({
    homeDir: root,
    databaseFile: path.join(root, "usage.sqlite"),
    env: {},
    importDirs: [],
  });
  const sourceA = path.join(root, "a.jsonl");
  const sourceB = path.join(root, "b.sqlite");
  try {
    await store.open();
    store.database.exec("PRAGMA recursive_triggers = OFF");
    store.homes = [
      { id: "home-a", kind: "main", label: "Home A", path: root },
      { id: "home-b", kind: "zcode", label: "Home B", path: root },
    ];
    for (const [index, sourcePath] of [sourceA, sourceB].entries()) {
      const home = store.homes[index];
      insert(store.database, "source_files", {
        path: sourcePath,
        kind: home.kind,
        home_id: home.id,
        home_label: home.label,
        home_path: root,
        size: 1,
        mtime_ms: 1,
        indexed_at: NOW,
      });
    }
    insert(store.database, "events", event(sourceA, { id: 1 }));
    insert(
      store.database,
      "events",
      event(sourceB, {
        id: 2,
        session_id: "q2-session-b",
        home_id: "home-b",
        home_label: "Home B",
        channel: "zcode",
        project: "/work/b",
        total: 200,
        input: 180,
      }),
    );
    insert(store.database, "rate_limit_observations", observation(sourceA));
    const normalized = normalizePerfSample({
      sourceKind: "zcode",
      identity: ["q2-request"],
      homeId: "home-b",
      sourcePath: sourceB,
      channel: "zcode",
      agentKind: "unknown",
      agent: "",
      sessionId: "q2-session-b",
      turnKey: "",
      model: "gpt-6-sol",
      modelProvider: "",
      reasoningEffort: "",
      modelEvidence: "",
      status: "completed",
      tsMs: Date.parse("2026-10-04T12:01:00.000Z"),
      windowStartMs: Date.parse("2026-10-04T12:01:00.000Z"),
      windowEndMs: Date.parse("2026-10-04T12:01:01.000Z"),
      durationMs: 1000,
      outputTokens: 100,
      requestCount: 1,
    });
    assert.ok(normalized.sample, JSON.stringify(normalized.warnings));
    store.insertPerfSample(normalized.sample);
    store.generatedAt = NOW;
    store.writeMeta("generated_at", NOW);
    store.writeMeta("perf_indexed_at", NOW);
    store.writeMeta("perf_index_version", "q2-initial");
    store.writeMeta("perf_method_version", PERF_METHOD_VERSION);
    store.writeMeta("perf_missing_sources", "[]");
    store.writePerfState("ready");
    await run({ store, sourceA, sourceB });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Q2 no-op metadata and perf commits retain all timeline while refreshing state, TPS and time", async () => {
  await withStore(async ({ store, sourceB }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "initial full components");
    const warmCalls = calls();
    assert.equal(before.summary.totals.total, 300);
    assert.equal(before.summary.perf.models[0].averageTps, 100);
    assert.deepEqual(components(store), before);
    assert.equal(calls(), warmCalls);

    store.database.exec("BEGIN IMMEDIATE");
    store.writeMeta("generated_at", NOW);
    store.writeMeta("perf_indexed_at", LATER);
    store.database.exec("COMMIT");
    const metadata = await assertFresh(store, "metadata commit must keep complete usage");
    assert.equal(calls(), warmCalls, "metadata-only commit must not call the all timeline");
    assert.equal(metadata.summary.perf.indexedAt, LATER);
    assert.equal(metadata.summary.perf.meta.indexedAt, LATER);
    assert.deepEqual(metadata.summary.timeline, before.summary.timeline);

    store.database.exec("BEGIN IMMEDIATE");
    store.database.prepare("UPDATE perf_samples SET output_tokens = 150, duration_ms = 500").run();
    store.writeMeta("perf_index_version", "q2-perf-only");
    store.database.exec("COMMIT");
    store.commitStoreRevision("perf");
    const perf = await assertFresh(store, "actual perf commit must re-read the perf facts");
    assert.equal(calls(), warmCalls, "perf revision must retain the all usage timeline");
    assert.equal(perf.summary.perf.models[0].averageTps, 300);
    assert.equal(perf.summary.perf.indexVersion, "q2-perf-only");
    assert.deepEqual(perf.summary.timeline, before.summary.timeline);

    const warning = { sourceKind: "zcode", homeId: "home-b", code: "LIVE_SOURCE_CHANGED", count: 1 };
    store.writePerfState("degraded", { sourceWarnings: [warning] });
    store.writeMeta("perf_missing_sources", JSON.stringify([{ path: sourceB, homeId: "home-b" }]));
    const degraded = await assertFresh(store, "perf status must never be retained as old ready");
    assert.equal(calls(), warmCalls);
    assert.equal(degraded.summary.perf.state, "degraded");
    assert.equal(degraded.summary.perf.ready, false);
    assert.deepEqual(degraded.summary.perf.sourceWarnings, [warning]);
    assert.equal(degraded.summary.perf.missingSources[0].path, sourceB);
  });
});

test("Q2 raw events, quota and source writes refresh all independent components and cascades", async () => {
  await withStore(async ({ store, sourceA, sourceB }) => {
    const calls = countAllTimelines(store);
    await assertFresh(store, "warm raw SQL fixture");
    const readers = [
      ["metadata", () => store.metadata(new Date(NOW))],
      ["periodComparison", () => store.periodComparison(FILTERS)],
      ["observations", () => store.quotaObservations()],
    ];
    let firstReader = 0;
    const change = async (label, mutate) => {
      const before = calls();
      mutate();
      const [field, read] = readers[firstReader++ % readers.length];
      const independent = structuredClone(read());
      const actual = await assertFresh(store, label);
      assert.deepEqual(independent, actual[field], `${label}: ${field} must be fresh before other readers run`);
      assert.ok(calls() > before, `${label}: all timeline must miss`);
      return actual;
    };
    const updated = await change("raw event update", () => {
      store.database.prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1").run();
    });
    assert.equal(updated.summary.totals.total, 307);
    const added = await change("raw event insert adds a model", () => {
      insert(store.database, "events", event(sourceA, { id: 3, model: "q2-new-model", session_id: "new-session" }));
    });
    assert.equal(added.metadata.eventCount, 3);
    assert.ok(added.metadata.harnessModels.Codex.includes("q2-new-model"));
    await change("raw event delete", () => store.database.prepare("DELETE FROM events WHERE id = 3").run());
    const quota = await change("raw quota update", () => {
      store.database.prepare("UPDATE rate_limit_observations SET used_percent = 73").run();
    });
    assert.equal(quota.quotaSummary.quota.windows.quota_5h.usedPercent, 73);
    const observationAdded = await change("raw quota insert", () => {
      insert(store.database, "rate_limit_observations", observation(sourceA, { line_number: 2 }));
    });
    assert.equal(observationAdded.observations.length, 2);
    await change("raw quota delete", () => {
      store.database.prepare("DELETE FROM rate_limit_observations WHERE line_number = 2").run();
    });
    await change("raw source kind update", () => {
      store.database.prepare("UPDATE source_files SET kind = 'dsh' WHERE path = ?").run(sourceB);
    });
    await change("raw source insert", () => {
      store.database
        .prepare(`
          INSERT INTO source_files
          SELECT ?, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at
          FROM source_files WHERE path = ?
        `)
        .run(`${sourceB}.extra`, sourceB);
    });
    const deleted = await change("source delete cascades to usage and quota", () => {
      store.database.prepare("DELETE FROM source_files WHERE path = ?").run(sourceA);
    });
    assert.equal(deleted.summary.totals.total, 200);
    assert.equal(deleted.metadata.eventCount, 1);
    assert.deepEqual(deleted.observations, []);
    const empty = await change("source delete also cascades to perf", () => {
      store.database.prepare("DELETE FROM source_files WHERE path = ?").run(sourceB);
    });
    assert.equal(empty.summary.totals.total, 0);
    assert.equal(empty.metadata.eventCount, 0);
    assert.equal(empty.summary.perf.coverage.eligible, 0);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("Q2 a warm all timeline does not freeze quota reset or period asOf", async () => {
  await withStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "one millisecond before quota reset", {
      ...FILTERS,
      now: "2026-10-04T16:59:59.999Z",
    });
    const warmCalls = calls();
    const after = await assertFresh(store, "at the exact quota reset", {
      ...FILTERS,
      now: "2026-10-04T17:00:00.000Z",
    });
    assert.equal(before.summary.quota.windows.quota_5h.state, "available");
    assert.equal(after.summary.quota.windows.quota_5h.state, "waiting");
    assert.equal(after.quotaSummary, null);
    assert.equal(after.periodComparison.asOf, "2026-10-04T17:00:00.000Z");
    assert.deepEqual(after.summary.timeline, before.summary.timeline);
    assert.equal(calls(), warmCalls, "clock-derived output must update without rebuilding unchanged usage");
  });
});

for (const outcome of ["success", "FAIL", "ABORT"]) {
  test(`Q2 ignored metadata trigger side effects remain visible after ${outcome}`, async () => {
    await withStore(async ({ store }) => {
      store.database.exec(`
        CREATE TRIGGER q2_meta_side_effect AFTER UPDATE OF value ON store_meta
        WHEN NEW.key = 'perf_indexed_at' AND NEW.value = '${LATER}'
        BEGIN
          UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1;
          UPDATE rate_limit_observations SET used_percent = 73;
          UPDATE source_files SET kind = 'dsh' WHERE home_id = 'home-b';
          ${outcome === "success" ? "" : `SELECT RAISE(${outcome}, 'q2 injected metadata failure');`}
        END;
      `);
      const calls = countAllTimelines(store);
      const before = await assertFresh(store, "warm after installing the side-effect trigger");
      const warmCalls = calls();
      const write = () => store.writeMeta("perf_indexed_at", LATER);
      if (outcome === "success") write();
      else assert.throws(write, /q2 injected metadata failure/);
      const after = await assertFresh(store, `${outcome}: compare actual retained SQL effects`);
      if (outcome === "ABORT") assert.deepEqual(after, before, "ABORT must undo the whole failed statement");
      else {
        assert.equal(after.summary.totals.total, 307);
        assert.equal(after.observations[0].usedPercent, 73);
        assert.ok(calls() > warmCalls, "retained usage side effect must not hit the old timeline");
      }
    });
  });
}

test("Q2 external commits without publication markers invalidate twice", async () => {
  await withStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    await assertFresh(store, "warm before external writes");
    const fingerprint = store.readMeta("fingerprint");
    const generatedAt = store.readMeta("generated_at");
    const writer = new DatabaseSync(store.databaseFile);
    try {
      for (const total of [310, 320]) {
        const before = calls();
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("UPDATE events SET total = ?, input = ? WHERE id = 1").run(total - 200, total - 220);
        writer.prepare("UPDATE rate_limit_observations SET used_percent = ?").run(total - 250);
        writer.exec("COMMIT");
        const actual = await assertFresh(store, `external commit ${total}`);
        assert.equal(actual.summary.totals.total, total);
        assert.equal(actual.observations[0].usedPercent, total - 250);
        assert.ok(calls() > before);
        assert.equal(store.readMeta("fingerprint"), fingerprint);
        assert.equal(store.readMeta("generated_at"), generatedAt);
      }
    } finally {
      writer.close();
    }
  });
});

test("Q2 controlled writeDepth rollback cannot publish uncommitted usage, quota or perf", async () => {
  await withStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "committed transaction baseline");
    store.database.exec("BEGIN IMMEDIATE");
    store.writeTransactionDepth += 1;
    try {
      store.database.prepare("UPDATE events SET total = total + 50, input = input + 50 WHERE id = 1").run();
      store.database.prepare("UPDATE rate_limit_observations SET used_percent = 99").run();
      store.database.prepare("UPDATE perf_samples SET output_tokens = 500").run();
      const uncommitted = components(store, true);
      assert.equal(uncommitted.summary.totals.total, 350);
      assert.equal(uncommitted.observations[0].usedPercent, 99);
      assert.equal(uncommitted.quotaSummary.quota.windows.quota_5h.usedPercent, 99);
      assert.equal(uncommitted.summary.perf.models[0].averageTps, 500);
      assert.notDeepEqual(uncommitted.periodComparison, before.periodComparison);
    } finally {
      store.database.exec("ROLLBACK");
      store.writeTransactionDepth -= 1;
    }
    assert.deepEqual(await assertFresh(store, "rolled-back state equals a committed fresh reader"), before);
    const committedCalls = calls();
    assert.deepEqual(components(store), before);
    assert.equal(calls(), committedCalls, "a committed snapshot can warm again after rollback");
  });
});

test("Q2 warm recursive ON REPLACE collision always uses the complete-count fallback", async () => {
  await withStore(async ({ store }) => {
    store.database.exec("PRAGMA recursive_triggers = ON");
    const calls = countAllTimelines(store);
    await assertFresh(store, "warm while recursive triggers are already ON");
    const warmCalls = calls();
    const totalChanges = () => Number(store.database.prepare("SELECT total_changes() AS n").get().n);
    const before = totalChanges();
    store.database.prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1").run();
    const usageChanges = totalChanges() - before;
    assert.ok(usageChanges > 0);
    // Each ignored REPLACE can offset one usage change under the rejected T-2C formula.
    for (let index = 0; index < usageChanges; index += 1) {
      store.database.prepare("INSERT OR REPLACE INTO store_meta(key, value) VALUES('perf_indexed_at', ?)").run(LATER);
    }
    const actual = await assertFresh(store, "recursive ON must reject the stale usage projection");
    assert.ok(calls() > warmCalls);
    assert.equal(actual.summary.totals.total, 307);
    assert.equal(
      actual.summary.timeline.reduce((sum, row) => sum + row.total.total, 0),
      307,
    );
    assert.equal(actual.summary.perf.indexedAt, LATER);
  });
});

for (const target of ["metadata", "perf samples"]) {
  test(`Q2 OFF warm then ON ${target} REPLACE plus usage then OFF cannot bypass the fallback`, async () => {
    await withStore(async ({ store }) => {
      const calls = countAllTimelines(store);
      await assertFresh(store, "warm with recursive triggers OFF");
      const warmCalls = calls();
      const totalChanges = () => Number(store.database.prepare("SELECT total_changes() AS n").get().n);
      const replace = () => {
        if (target === "metadata") {
          store.database
            .prepare("INSERT OR REPLACE INTO store_meta(key, value) VALUES('perf_indexed_at', ?)")
            .run(LATER);
        } else store.database.exec("INSERT OR REPLACE INTO perf_samples SELECT * FROM perf_samples");
      };
      store.database.exec("PRAGMA recursive_triggers = ON");
      replace();
      const beforeUsage = totalChanges();
      store.database.prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1").run();
      const usageChanges = totalChanges() - beforeUsage;
      assert.ok(usageChanges > 0);
      for (let index = 1; index < usageChanges; index += 1) replace();
      store.database.exec("PRAGMA recursive_triggers = OFF");
      const after = await assertFresh(store, "read-time OFF must not erase intervening ON writes");
      assert.ok(calls() > warmCalls, "ON writes must never have been subtracted by the TEMP triggers");
      assert.equal(after.summary.totals.total, 307);
      assert.equal(
        after.summary.timeline.reduce((sum, row) => sum + row.total.total, 0),
        307,
      );
    });
  });
}

for (const operation of ["INSERT", "UPDATE"]) {
  test(`Q2 recursive OFF ${operation} OR REPLACE rowid conflict cannot hide unknown metadata deletion`, async () => {
    await withStore(async ({ store }) => {
      if (operation === "INSERT") {
        store.database.prepare("DELETE FROM store_meta WHERE key = 'perf_indexed_at'").run();
      }
      store.writeMeta("q2_ordinary", NOW);
      const ordinaryRowid = store.database
        .prepare("SELECT rowid FROM store_meta WHERE key = 'q2_ordinary'")
        .get().rowid;
      const calls = countAllTimelines(store);
      await assertFresh(store, "ordinary row before rowid replacement");
      const warmCalls = calls();
      if (operation === "INSERT") {
        store.database
          .prepare(`
          INSERT OR REPLACE INTO store_meta(rowid, key, value)
          SELECT rowid, 'perf_indexed_at', ? FROM store_meta WHERE key = 'q2_ordinary'
        `)
          .run(LATER);
      } else {
        store.database
          .prepare(`
          UPDATE OR REPLACE store_meta SET rowid = ?, value = ? WHERE key = 'perf_indexed_at'
        `)
          .run(ordinaryRowid, LATER);
      }
      assert.equal(store.database.prepare("SELECT 1 FROM store_meta WHERE key = 'q2_ordinary'").get(), undefined);
      assert.equal(
        store.database.prepare("SELECT rowid FROM store_meta WHERE key = 'perf_indexed_at'").get().rowid,
        ordinaryRowid,
      );
      const after = await assertFresh(store, "implicit deletion of unknown metadata must remain in the usage guard");
      assert.ok(calls() > warmCalls, `${operation} conflict must invalidate despite the unchanged white key`);
      assert.equal(after.summary.perf.indexedAt, LATER);
    });
  });
}

for (const operation of ["UPDATE", "UPSERT"]) {
  test(`Q2 metadata key renames via ${operation} check both OLD and NEW`, async () => {
    await withStore(async ({ store }) => {
      store.database.prepare("DELETE FROM store_meta WHERE key = 'perf_missing_sources'").run();
      store.writeMeta("q2_unknown_key", "[]");
      const calls = countAllTimelines(store);
      await assertFresh(store, "unknown metadata key baseline");
      for (const [from, to] of [
        ["q2_unknown_key", "perf_missing_sources"],
        ["perf_missing_sources", "q2_unknown_key"],
      ]) {
        const before = calls();
        if (operation === "UPDATE") {
          store.database.prepare("UPDATE store_meta SET key = ? WHERE key = ?").run(to, from);
        } else {
          store.database
            .prepare(`
            INSERT INTO store_meta(key, value) VALUES(?, '[]')
            ON CONFLICT(key) DO UPDATE SET key = ?, value = excluded.value
          `)
            .run(from, to);
        }
        await assertFresh(store, `${from} to ${to}: both OLD and NEW matter`);
        assert.ok(calls() > before, "a non-ignored endpoint cannot be subtracted as perf-only");
      }
    });
  });
}

for (const damage of ["main schema", "TEMP reset"]) {
  test(`Q2 ${damage} change falls back without relying on tracker names`, async () => {
    await withStore(async ({ store }) => {
      const calls = countAllTimelines(store);
      await assertFresh(store, "warm before schema damage");
      store.writeMeta("perf_indexed_at", LATER);
      await assertFresh(store, "establish ignored writes before damage");
      const before = calls();
      if (damage === "main schema") store.database.exec("CREATE TABLE q2_unknown_schema(value INTEGER)");
      else {
        const setting = Number(store.database.prepare("PRAGMA temp_store").get().temp_store);
        store.database.exec(`PRAGMA temp_store = ${setting === 2 ? 1 : 2}`);
      }
      await assertFresh(store, "DDL alone must invalidate the old guarded projection");
      assert.ok(calls() > before, "schema/TEMP guard must reject the previously warmed usage slot");
      store.database.prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1").run();
      store.writeMeta("perf_indexed_at", NOW);
      const after = await assertFresh(store, "untracked writes remain visible after schema damage");
      assert.equal(after.summary.totals.total, 307);
    });
  });
}

function ledgerLine(record) {
  return `${JSON.stringify({
    agent: "codex",
    provider: "codex",
    req: `codex/${record.requestedModel}`,
    model: record.requestedModel,
    response_id: record.responseId,
    status: 200,
    ms: record.durationMs,
    out: record.reportedOutputTokens,
    stop: "completed",
    ep: "/backend-api/codex/responses",
  })}\n`;
}

const LATE_TIMING = {
  schemaVersion: 1,
  evidenceOrigin: "fixture@1",
  responseId: "q2-response",
  requestedModel: "q2-late-model",
  reportedOutputTokens: 137,
  durationMs: 4000,
  status: "completed",
  completedAtMs: null,
};

async function withNativeStore(run) {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const ledger = path.join(fixture.serverOptions.homeDir, ".config", "magpie", "usage.jsonl");
  const timestamp = "2026-10-04T12:10:00.000Z";
  const threadId = "fixture-codex-thread";
  const turnId = "q2-turn";
  try {
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, fixture.timingRecords.map(ledgerLine).join(""));
    appendFileSync(
      fixture.rolloutFiles[0],
      `${[
        { type: "turn_context", payload: { thread_id: threadId, turn_id: turnId, model: LATE_TIMING.requestedModel } },
        {
          type: "token_usage_record",
          timestamp,
          payload: {
            thread_id: threadId,
            turn_id: turnId,
            response_id: LATE_TIMING.responseId,
            usage: { output_tokens: 137 },
            turn_token_usage: { output_tokens: 137 },
          },
        },
        {
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 100, output_tokens: 137, total_tokens: 237 } },
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    );
    appendFileSync(
      fixture.rolloutFiles[2],
      `${[
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: threadId,
            turn_id: turnId,
            item: { id: "q2-item", type: "AgentMessage" },
            started_at_ms: Date.parse(timestamp) - 1,
            completed_at_ms: Date.parse(timestamp),
          },
        },
        { type: "event_msg", payload: { type: "task_complete", thread_id: threadId, turn_id: turnId } },
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    );
    await store.open();
    store.database.exec("PRAGMA recursive_triggers = OFF");
    await store.sync();
    await run({ store, ledger });
  } finally {
    store.close();
    fixture.close();
  }
}

function assertLateTiming(before, after) {
  const perf = after.summary.perf;
  const model = perf.models.find((entry) => entry.model === LATE_TIMING.requestedModel);
  assert.equal(model.n, 1);
  for (const field of ["averageTps", "p10", "p90"]) assert.equal(model[field], 34.25, field);
  const group = perf.groups.find((entry) => entry.model === LATE_TIMING.requestedModel);
  assert.deepEqual(group.tps, { p10: 34.25, p50: 34.25, p90: 34.25, pooled: 34.25 });
  assert.deepEqual(group.durationMs, { p50: 4000, p90: 4000 });
  assert.deepEqual(group.sums, { outputTokens: 137, durationMs: 4000 });
  assert.equal(perf.coverage.sampled, before.summary.perf.coverage.sampled + 1);
  assert.equal(
    perf.codexTimingCoverage.sampledOutputTokens,
    before.summary.perf.codexTimingCoverage.sampledOutputTokens + 137,
  );
  assert.notEqual(perf.indexVersion, before.summary.perf.indexVersion);
}

test("Q2 no-op sync retains independent range caches without ever warming all", async () => {
  await withNativeStore(async ({ store }) => {
    const allCalls = countAllTimelines(store);
    const metadata = store.metadata(new Date(NOW));
    const metadataSlot = store.metadataCache;
    const comparison = store.periodComparison(FILTERS);
    const comparisonSlot = [...store.periodComparisonCache.values()][0];
    for (let round = 0; round < 3; round += 1) {
      assert.equal((await store.sync()).updatedFileCount, 0);
      assert.equal(store.metadataCache, metadataSlot, "no-op must preserve the static metadata slot");
      assert.equal([...store.periodComparisonCache.values()][0], comparisonSlot);
      for (const preset of ["today", "month"]) {
        const dashboard = await store.dashboardHistory(
          { ...FILTERS, preset, now: new Date(NOW) },
          { includeDetails: false },
        );
        assert.equal(dashboard.metadata.eventCount, metadata.eventCount);
        assert.deepEqual(dashboard.periodComparison.totals, comparison.totals);
      }
      assert.equal(store.metadataCache, metadataSlot);
    }
    assert.equal(allCalls(), 0, "all must never be warmed by this regression");
    store.database
      .prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = (SELECT MIN(id) FROM events)")
      .run();
    assert.equal(store.periodComparison(FILTERS).totals.today.total, comparison.totals.today.total + 7);
  });
});

test("Q2 real ledger-only import then perf publication retains the usage timeline", async () => {
  await withNativeStore(async ({ store, ledger }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "native candidate before late ledger timing");
    assert.ok(before.summary.totals.total > 0, "the retained usage projection must contain actual usage");
    const missing = before.summary.perf.models.find((entry) => entry.model === LATE_TIMING.requestedModel);
    assert.equal(missing.state, "missing_duration");
    const warmCalls = calls();
    appendFileSync(ledger, ledgerLine(LATE_TIMING));
    const status = await store.sync();
    assert.equal(status.updatedFileCount, 0);
    const after = await assertFresh(store, "real ledger-only full dashboard components");
    assert.equal(calls(), warmCalls, "the same writer must not rebuild all timeline after timing/perf commits");
    assertLateTiming(before, after);
    const beforeUsage = structuredClone(before.summary);
    const afterUsage = structuredClone(after.summary);
    delete beforeUsage.perf;
    delete beforeUsage.generatedAt;
    delete afterUsage.perf;
    delete afterUsage.generatedAt;
    assert.deepEqual(afterUsage, beforeUsage);
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.equal(store.perfPublicationState().timingRevision, "");
  });
});

test("Q2 raw usage and quota between request-timing and perf commits cannot be retained as ledger-only", async () => {
  await withNativeStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "before explicit timing import");
    const home = store.homes.find((entry) => entry.kind === "extra");
    assert.ok(home);
    const imported = store.importRequestTimingEvidence({
      homeId: home.id,
      records: [LATE_TIMING],
      reviewedOrigins: [LATE_TIMING.evidenceOrigin],
    });
    assert.equal(imported.changed, true);
    assert.notEqual(store.perfPublicationState().timingRevision, "");
    const warmCalls = calls();
    store.database
      .prepare("UPDATE events SET total = total + 7, input = input + 7 WHERE id = (SELECT MIN(id) FROM events)")
      .run();
    const sourcePath = store.database.prepare("SELECT source_path FROM events ORDER BY id LIMIT 1").get().source_path;
    insert(store.database, "rate_limit_observations", observation(sourcePath, { line_number: 999, used_percent: 73 }));
    const intermediate = await assertFresh(store, "raw facts committed between evidence and perf publication");
    assert.equal(intermediate.summary.totals.total, before.summary.totals.total + 7);
    assert.equal(intermediate.quotaSummary.quota.windows.quota_5h.usedPercent, 73);
    assert.ok(calls() > warmCalls);
    assert.deepEqual(intermediate.summary.perf.models, before.summary.perf.models, "import alone must not publish TPS");
    const intermediateCalls = calls();
    await store.sync();
    const after = await assertFresh(store, "published timing retains the updated usage, period and quota");
    assertLateTiming(before, after);
    assert.equal(after.summary.totals.total, intermediate.summary.totals.total);
    assert.equal(after.quotaSummary.quota.windows.quota_5h.usedPercent, 73);
    // The preceding raw event write leaves dirty rollups for sync to rebuild conservatively.
    assert.ok(calls() - intermediateCalls <= 1, "rollup maintenance may cause one conservative timeline rebuild");
    const stableCalls = calls();
    for (let read = 0; read < 2; read += 1) {
      assert.deepEqual(components(store), after, "consecutive reads must preserve the complete committed result");
      assert.equal(calls(), stableCalls, "consecutive reads without writes must hit the warm all timeline");
    }
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.equal(store.perfPublicationState().timingRevision, "");
  });
});
