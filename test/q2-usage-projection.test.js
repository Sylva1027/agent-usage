import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

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
    store.generatedAt = NOW;
    store.writeMeta("generated_at", NOW);
    await run({ store, sourceA, sourceB });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Q2 no-op metadata commits retain all timeline while refreshing state", async () => {
  await withStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "initial full components");
    const warmCalls = calls();
    assert.equal(before.summary.totals.total, 300);
    assert.deepEqual(components(store), before);
    assert.equal(calls(), warmCalls);

    store.database.exec("BEGIN IMMEDIATE");
    store.writeMeta("generated_at", LATER);
    store.database.exec("COMMIT");
    store.generatedAt = LATER;
    const metadata = await assertFresh(store, "metadata commit must keep complete usage");
    assert.equal(calls(), warmCalls, "metadata-only commit must not call the all timeline");
    assert.equal(store.readMeta("generated_at"), LATER);
    assert.equal(metadata.metadata.generatedAt, LATER);
    assert.deepEqual(metadata.summary.timeline, before.summary.timeline);
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
    const empty = await change("source delete also cascades to remaining usage", () => {
      store.database.prepare("DELETE FROM source_files WHERE path = ?").run(sourceB);
    });
    assert.equal(empty.summary.totals.total, 0);
    assert.equal(empty.metadata.eventCount, 0);
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
        WHEN NEW.key = 'generated_at' AND NEW.value = '${LATER}'
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
      const write = () => store.writeMeta("generated_at", LATER);
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

test("Q2 controlled writeDepth rollback cannot publish uncommitted usage or quota", async () => {
  await withStore(async ({ store }) => {
    const calls = countAllTimelines(store);
    const before = await assertFresh(store, "committed transaction baseline");
    store.database.exec("BEGIN IMMEDIATE");
    store.writeTransactionDepth += 1;
    try {
      store.database.prepare("UPDATE events SET total = total + 50, input = input + 50 WHERE id = 1").run();
      store.database.prepare("UPDATE rate_limit_observations SET used_percent = 99").run();
      const uncommitted = components(store, true);
      assert.equal(uncommitted.summary.totals.total, 350);
      assert.equal(uncommitted.observations[0].usedPercent, 99);
      assert.equal(uncommitted.quotaSummary.quota.windows.quota_5h.usedPercent, 99);
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
      store.database.prepare("INSERT OR REPLACE INTO store_meta(key, value) VALUES('generated_at', ?)").run(LATER);
    }
    const actual = await assertFresh(store, "recursive ON must reject the stale usage projection");
    assert.ok(calls() > warmCalls);
    assert.equal(actual.summary.totals.total, 307);
    assert.equal(
      actual.summary.timeline.reduce((sum, row) => sum + row.total.total, 0),
      307,
    );
  });
});

for (const target of ["metadata"]) {
  test(`Q2 OFF warm then ON ${target} REPLACE plus usage then OFF cannot bypass the fallback`, async () => {
    await withStore(async ({ store }) => {
      const calls = countAllTimelines(store);
      await assertFresh(store, "warm with recursive triggers OFF");
      const warmCalls = calls();
      const totalChanges = () => Number(store.database.prepare("SELECT total_changes() AS n").get().n);
      const replace = () => {
        if (target === "metadata") {
          store.database.prepare("INSERT OR REPLACE INTO store_meta(key, value) VALUES('generated_at', ?)").run(LATER);
        }
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
        store.database.prepare("DELETE FROM store_meta WHERE key = 'generated_at'").run();
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
          SELECT rowid, 'generated_at', ? FROM store_meta WHERE key = 'q2_ordinary'
        `)
          .run(LATER);
      } else {
        store.database
          .prepare(`
          UPDATE OR REPLACE store_meta SET rowid = ?, value = ? WHERE key = 'generated_at'
        `)
          .run(ordinaryRowid, LATER);
      }
      assert.equal(store.database.prepare("SELECT 1 FROM store_meta WHERE key = 'q2_ordinary'").get(), undefined);
      assert.equal(
        store.database.prepare("SELECT rowid FROM store_meta WHERE key = 'generated_at'").get().rowid,
        ordinaryRowid,
      );
      const after = await assertFresh(store, "implicit deletion of unknown metadata must remain in the usage guard");
      assert.ok(calls() > warmCalls, `${operation} conflict must invalidate despite the unchanged white key`);
      assert.equal(after.summary.totals.total, 300);
    });
  });
}

for (const operation of ["UPDATE", "UPSERT"]) {
  test(`Q2 metadata key renames via ${operation} check both OLD and NEW`, async () => {
    await withStore(async ({ store }) => {
      store.database.prepare("DELETE FROM store_meta WHERE key = 'generated_at'").run();
      store.writeMeta("q2_unknown_key", "[]");
      const calls = countAllTimelines(store);
      await assertFresh(store, "unknown metadata key baseline");
      for (const [from, to] of [
        ["q2_unknown_key", "generated_at"],
        ["generated_at", "q2_unknown_key"],
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
        assert.ok(calls() > before, "a non-ignored endpoint cannot be subtracted as metadata-only");
      }
    });
  });
}

for (const damage of ["main schema", "TEMP reset"]) {
  test(`Q2 ${damage} change falls back without relying on tracker names`, async () => {
    await withStore(async ({ store }) => {
      const calls = countAllTimelines(store);
      await assertFresh(store, "warm before schema damage");
      store.writeMeta("generated_at", LATER);
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
      store.writeMeta("generated_at", NOW);
      const after = await assertFresh(store, "untracked writes remain visible after schema damage");
      assert.equal(after.summary.totals.total, 307);
    });
  });
}

test("Q2 no-op sync retains independent range caches without warming all", async () => {
  await withStore(async ({ store }) => {
    await store.sync();
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
