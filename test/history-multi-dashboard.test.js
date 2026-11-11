import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { checkpointUsageStore } from "../src/usage-executor.js";
import { UsageHistoryQuery } from "../src/usage-history-query.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_META = "history_archive_event_authority";
const REVISION_META = "history_archive_event_revisions";
const NOW = new Date("2026-01-06T12:00:00.000Z");
const DAY_MS = 86_400_000;
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");

const SOURCES = [
  {
    kind: "codex",
    id: "home-codex",
    label: "主账户 東京",
    channel: "CLI",
    model: "gpt-6-sol",
    project: "项目 α",
  },
  {
    kind: "claude",
    id: "home-claude",
    label: "Claude 東",
    channel: "Claude Code",
    model: "claude-sonnet-4-5",
    project: "项目 β",
  },
  {
    kind: "opencode",
    id: "home-opencode",
    label: "OpenCode 西",
    channel: "OpenCode",
    model: "opencode-モデル",
    project: "项目 γ",
  },
  {
    kind: "zcode",
    id: "home-zcode",
    label: "智谱 南",
    channel: "ZCode",
    model: "glm-4.7",
    project: "项目 δ",
  },
  {
    kind: "dsh",
    id: "home-dsh",
    label: "DSH 北",
    channel: "DSH",
    model: "gpt-5.3-codex",
    project: "项目 ε",
  },
  {
    kind: "workbuddy",
    id: "home-workbuddy",
    label: "WorkBuddy 中",
    channel: "WorkBuddy",
    model: "gpt-5.2-codex",
    project: "项目 ζ",
  },
];

const DAILY_TOTALS = [
  [150, 120, 100, 90, 80, 60],
  [150, 120, 100, 90, 80, 60],
  [130, 110, 90, 70, 60, 40],
  [130, 110, 90, 70, 60, 40],
  [150, 120, 100, 80, 60, 40],
];

const DAILY_CACHED = [
  [10, 8, 6, 5, 4, 3],
  [10, 8, 6, 5, 4, 3],
  [10, 8, 6, 5, 4, 3],
  [10, 8, 6, 5, 4, 3],
  [70, 50, 40, 30, 20, 10],
];

const SQL_SUPPORTED = (() => {
  const database = new DatabaseSync(":memory:");
  try {
    return typeof database.isTransaction === "boolean";
  } finally {
    database.close();
  }
})();

function weekStart(day) {
  const date = new Date(day);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
  )
    .toISOString()
    .slice(0, 10);
}

function sessionId(sourceIndex, dayIndex) {
  if (sourceIndex === 0 && (dayIndex === 0 || dayIndex === 4)) return "shared-世界";
  if (sourceIndex === 1 && (dayIndex === 2 || dayIndex === 3)) return "tie-session";
  return `${SOURCES[sourceIndex].kind}-${dayIndex}-${sourceIndex}`;
}

function eventPayload(root, source, sourceIndex, dayIndex, total, cached) {
  const timestampMs = START_MS + dayIndex * DAY_MS + 2 * 60 * 60 * 1000 + sourceIndex * 60_000;
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  const input = Math.max(cached, Math.floor(total * 0.68));
  const output = Math.floor(total * 0.18);
  const reasoning = Math.floor(output * 0.2);
  const repositoryPath = path.join(root, "workspaces", source.kind, "项目-α");
  const sharedTier = sourceIndex === 0 && (dayIndex === 0 || dayIndex === 4);
  return {
    source_path: path.join(root, "sources", source.kind, "usage.jsonl"),
    timestamp_ms: timestampMs,
    session_id: sessionId(sourceIndex, dayIndex),
    home_id: source.id,
    home_label: source.label,
    channel: source.channel,
    project: source.project,
    model: source.model,
    hour_key: `${day} 02:00`,
    day_key: day,
    week_key: weekStart(day),
    month_key: day.slice(0, 7),
    cwd: repositoryPath,
    repository_key: `git:${repositoryPath}`,
    repository_path: repositoryPath,
    repository_kind: "git",
    detail_mask: [15, 15, 31, 15, 7, 31][sourceIndex],
    reconciliation_gap: sourceIndex === 2 ? 7 : 0,
    cache_write_tokens: sourceIndex === 2 ? 17 : 0,
    cache_write_known: sourceIndex === 2 ? 1 : 0,
    request_input_tokens: sourceIndex >= 2 ? input + 9 : 0,
    context_level: ["short", "long", "unknown", "short", "long", "unknown"][sourceIndex],
    service_tier: sharedTier ? "unknown" : ["standard", "fast", "priority", "default", "standard", "fast"][sourceIndex],
    price_version: "",
    total,
    input,
    cached,
    output,
    reasoning,
  };
}

function futurePayload(root) {
  const source = SOURCES.find((entry) => entry.kind === "zcode");
  const sourceIndex = SOURCES.indexOf(source);
  return {
    ...eventPayload(root, source, sourceIndex, 0, 1, 0),
    timestamp_ms: Date.parse("2030-01-01T00:00:00.000Z"),
    session_id: "future-未来",
    channel: "ZCode",
    project: "future 项目",
    model: "future-model-未",
    hour_key: "2030-01-01 00:00",
    day_key: "2030-01-01",
    week_key: "2029-12-31",
    month_key: "2030-01",
    detail_mask: 15,
    reconciliation_gap: 0,
    cache_write_tokens: 0,
    cache_write_known: 0,
    request_input_tokens: 0,
    context_level: "unknown",
    service_tier: "unknown",
    total: 1,
    input: 1,
    cached: 0,
    output: 0,
    reasoning: 0,
  };
}

function insertRows(database, table, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

function metadataHomes(root) {
  return SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    path: path.join(root, "homes", source.kind),
    kind: source.kind,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function writeMeta(store, key, value) {
  store.database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

async function applyRevisionOverlay(store, archives) {
  const updateRecord = archives[2];
  const deleteRecord = archives[3];
  const updateRows = await store.readHistoryArchiveEvents(updateRecord.segment_id);
  const deleteRows = await store.readHistoryArchiveEvents(deleteRecord.segment_id);
  const updateRow = updateRows.find((row) => row.source_path === SOURCES[0].source_path);
  const deleteRow = deleteRows.find((row) => row.source_path === SOURCES[1].source_path);
  assert.ok(updateRow, "revision fixture requires a codex row in the third archive");
  assert.ok(deleteRow, "revision fixture requires a claude row in the fourth archive");

  const { id: _updateId, ...updatePayload } = updateRow;
  const { id: _deleteId, ...deletePayload } = deleteRow;
  const revisedPayload = {
    ...updatePayload,
    detail_mask: 15,
    reconciliation_gap: 0,
    cache_write_tokens: 23,
    cache_write_known: 1,
    request_input_tokens: 659,
    context_level: "long",
    service_tier: "fast",
    price_version: "revision-v1",
    total: 700,
    input: 650,
    cached: 500,
    output: 50,
    reasoning: 0,
  };
  const identity = (sourcePath) => ({
    ...store.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(sourcePath),
  });
  writeMeta(store, REVISION_META, {
    formatVersion: 1,
    revisions: [
      {
        segmentId: updateRecord.segment_id,
        databaseSha256: updateRecord.database_sha256,
        sourceIdentity: identity(SOURCES[0].source_path),
        removed: [{ payload: updatePayload, count: 1 }],
        added: [{ payload: revisedPayload, count: 1 }],
      },
      {
        segmentId: deleteRecord.segment_id,
        databaseSha256: deleteRecord.database_sha256,
        sourceIdentity: identity(SOURCES[1].source_path),
        removed: [{ payload: deletePayload, count: 1 }],
        added: [],
      },
    ],
  });
}

async function createFixture({ archiveDays = [], revision = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-multi-dashboard-"));
  const store = new UsageStore({
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    env: {},
    importDirs: [],
  });
  try {
    await store.open();
    const sourceRows = SOURCES.map((source) => ({
      path: path.join(root, "sources", source.kind, "usage.jsonl"),
      kind: source.kind,
      home_id: source.id,
      home_label: source.label,
      home_path: path.join(root, "homes", source.kind),
      size: 1,
      mtime_ms: 1,
      indexed_at: "2026-01-06T00:00:00.000Z",
    }));
    for (const [index, source] of SOURCES.entries()) source.source_path = sourceRows[index].path;

    const eventRows = [];
    for (let dayIndex = 0; dayIndex < DAILY_TOTALS.length; dayIndex += 1) {
      for (let sourceIndex = 0; sourceIndex < SOURCES.length; sourceIndex += 1) {
        eventRows.push(
          eventPayload(
            root,
            SOURCES[sourceIndex],
            sourceIndex,
            dayIndex,
            DAILY_TOTALS[dayIndex][sourceIndex],
            DAILY_CACHED[dayIndex][sourceIndex],
          ),
        );
      }
    }
    eventRows.push(futurePayload(root));

    store.database.exec("BEGIN IMMEDIATE");
    try {
      insertRows(store.database, "source_files", sourceRows);
      insertRows(store.database, "events", eventRows);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    store.homes = metadataHomes(root);
    store.generatedAt = "2026-01-06T00:00:00.000Z";
    store.warnings = ["fixture warning 世界"];
    store.serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [
        {
          threadId: "shared-世界",
          turns: [{ time: START_MS, tier: "priority" }],
        },
      ],
    });
    store.serviceTierEvidenceInput = "history-multi-dashboard-tier-v1";

    const candidateFiles = [];
    for (const dayIndex of archiveDays) {
      const candidateFile = path.join(root, `archive-${dayIndex + 1}.sqlite`);
      await createHistoryArchiveCandidate(store.database, candidateFile, {
        startMs: START_MS + dayIndex * DAY_MS,
        endMs: START_MS + (dayIndex + 1) * DAY_MS,
      });
      candidateFiles.push(candidateFile);
    }
    for (const candidateFile of candidateFiles) {
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidateFile));
    }

    const archives = store.database
      .prepare("SELECT * FROM archive_segments ORDER BY start_ms")
      .all()
      .map((row) => ({ ...row }));
    if (revision) await applyRevisionOverlay(store, archives);
    const authority = store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(AUTHORITY_META);
    assert.equal(Boolean(authority), archiveDays.length > 0);
    assert.equal(archives.length, archiveDays.length);
    return {
      root,
      store,
      archives,
      candidateFiles,
      close() {
        store.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

function filtersFor(scope) {
  const base = { bucket: "day", calendarZone: "utc", now: NOW };
  return scope === "all"
    ? { ...base, preset: "all" }
    : { ...base, preset: "custom", startDate: "2026-01-03", endDate: "2026-01-05" };
}

async function readDashboardParity(store, filters, archived, options = { includeDetails: false }) {
  const originalTrySql = store.trySqlHistoryDashboard;
  let oracleTrySqlCalls = 0;
  store.trySqlHistoryDashboard = async () => {
    oracleTrySqlCalls += 1;
    return null;
  };
  let oracle;
  try {
    oracle = await store.dashboardHistory(filters, options);
  } finally {
    store.trySqlHistoryDashboard = originalTrySql;
  }
  assert.equal(oracleTrySqlCalls, archived ? 1 : 0, "oracle must enter the existing dashboard carrier path");

  const originalUnion = store.historyArchiveEventUnionForRange;
  let actualTrySqlCalls = 0;
  let unionCalls = 0;
  store.trySqlHistoryDashboard = async function (...args) {
    actualTrySqlCalls += 1;
    return originalTrySql.apply(this, args);
  };
  if (archived) {
    store.historyArchiveEventUnionForRange = async () => {
      unionCalls += 1;
      throw Object.assign(new Error("complete carrier was used by the candidate route"), {
        code: "CARRIER_USED",
      });
    };
  }
  let actual;
  try {
    actual = await store.dashboardHistory(filters, options);
  } finally {
    store.trySqlHistoryDashboard = originalTrySql;
    store.historyArchiveEventUnionForRange = originalUnion;
  }

  assert.equal(actualTrySqlCalls, archived ? 1 : 0, "warm/hot dashboard routing differs by authority");
  if (archived) assert.equal(unionCalls, 0, "archived candidates must use the bounded archive route");
  return { actual, oracle };
}

async function assertDashboardParity(store, filters, archived, options = { includeDetails: false }) {
  const result = await readDashboardParity(store, filters, archived, options);
  assert.deepEqual(result.actual, result.oracle, "dashboard must exactly equal the complete-carrier oracle");
  assert.equal(
    result.actual.summary.sessionCount <= result.actual.summary.eventCount,
    true,
    "summary session count is invalid",
  );
  assert.equal(
    result.actual.metadata.sessionCount < result.actual.metadata.eventCount,
    true,
    "metadata must deduplicate sessions",
  );
  assert.equal(result.actual.metadata.homeCount, SOURCES.length);
  return result;
}

const SHAPES = [
  { name: "hot only", archiveDays: [], revision: false },
  { name: "one archive plus hot", archiveDays: [3], revision: false },
  { name: "four archives plus hot", archiveDays: [0, 1, 2, 3], revision: false },
  { name: "four archives plus hot with revisions", archiveDays: [0, 1, 2, 3], revision: true },
];

test("mixed local history recalculates calendar keys retained from another timezone", async () => {
  const fixture = await createFixture({ archiveDays: [0, 1, 2, 3], revision: true });
  try {
    fixture.store.database.exec("UPDATE events SET day_key='1999-01-01',week_key='1998-12-28',month_key='1999-01'");
    await readDashboardParity(fixture.store, { ...filtersFor("custom"), calendarZone: "local" }, true, {
      includeDetails: false,
    });
  } finally {
    fixture.close();
  }
});

test("cold pricing uses committed source identity even when the live inventory is empty", async () => {
  const fixture = await createFixture({ archiveDays: [0, 1, 2, 3], revision: true });
  try {
    fixture.store.homes = [];
    fixture.store.database.exec(
      "UPDATE events SET model='gpt-6.1-sol',context_level='long',request_input_tokens=300001 WHERE home_id='home-codex'",
    );
    await readDashboardParity(fixture.store, filtersFor("all"), true, { includeDetails: false });
    await readDashboardParity(fixture.store, filtersFor("custom"), true, { includeDetails: false });
  } finally {
    fixture.close();
  }
});

for (const shape of SHAPES) {
  test(`${shape.name} keeps complete dashboard parity`, { skip: !SQL_SUPPORTED }, async (t) => {
    const fixture = await createFixture(shape);
    try {
      for (const scope of ["all", "custom"]) {
        await t.test(scope, async () => {
          const { actual, oracle } = await assertDashboardParity(
            fixture.store,
            filtersFor(scope),
            fixture.archives.length > 0,
          );
          if (scope === "all") {
            assert.equal(actual.summary.sessionCount < actual.summary.eventCount, true);
          }
          if (scope === "custom") {
            assert.deepEqual(actual.summary.records, oracle.summary.records);
            if (shape.revision) {
              assert.equal(oracle.summary.records.totalTokens?.period, "2026-01-03");
            } else {
              assert.equal(oracle.summary.records.totalTokens, undefined, "equal leading periods are not a winner");
              assert.equal(oracle.summary.records.cachedTokens?.period, "2026-01-05");
            }
          }
        });
      }
    } finally {
      fixture.close();
    }
  });
}

test("disk ordering preserves UTF-16 edge ordering and repository session order", {
  skip: !SQL_SUPPORTED,
}, async () => {
  const fixture = await createFixture({ archiveDays: [3] });
  const { store } = fixture;
  const timestampMs = Date.parse("2027-02-01T12:00:00.000Z");
  const repositoryPath = path.join(fixture.root, "edge-order", "项目-🚀-￿");
  const base = {
    ...eventPayload(fixture.root, SOURCES[0], 0, 0, 1, 0),
    timestamp_ms: timestampMs,
    project: repositoryPath,
    model: "gpt-6-sol",
    hour_key: "2027-02-01 12:00",
    day_key: "2027-02-01",
    week_key: "2027-02-01",
    month_key: "2027-02",
    cwd: repositoryPath,
    repository_key: `git:${repositoryPath}`,
    repository_path: repositoryPath,
    repository_kind: "git",
    detail_mask: 15,
    reconciliation_gap: 0,
    cache_write_tokens: 0,
    cache_write_known: 0,
    request_input_tokens: 0,
    context_level: "short",
    service_tier: "standard",
  };
  try {
    insertRows(store.database, "events", [
      {
        ...base,
        session_id: "edge-\u{10000}",
        total: 11,
        input: 11,
        cached: 0,
        output: 0,
        reasoning: 0,
      },
      {
        ...base,
        session_id: "edge-\uffff",
        total: 12,
        input: 12,
        cached: 0,
        output: 0,
        reasoning: 0,
      },
    ]);
    const filters = {
      preset: "custom",
      startDate: "2027-02-01",
      endDate: "2027-02-01",
      bucket: "day",
      calendarZone: "utc",
      now: new Date("2027-02-03T12:00:00.000Z"),
    };
    const { actual, oracle } = await readDashboardParity(store, filters, true, {
      includeDetails: true,
    });
    assert.deepEqual(actual.metadata, oracle.metadata);
    assert.deepEqual(actual.periodComparison, oracle.periodComparison);
    assert.equal(actual.summary.totals.total, 23);
    assert.deepEqual(actual.summary.repositories, oracle.summary.repositories);
    assert.equal(actual.summary.repositories.length, 1);
    assert.equal(actual.summary.repositories[0].sessions, 2);
    assert.deepEqual(new Set(actual.summary.repositories[0].sessionIds), new Set(["edge-\u{10000}", "edge-\uffff"]));
    assert.deepEqual(actual.summary, oracle.summary);
  } finally {
    fixture.close();
  }
});

test("detailed local exclusions preserve repository sessions and ordering", { skip: !SQL_SUPPORTED }, async () => {
  const fixture = await createFixture({ archiveDays: [0, 1, 2, 3], revision: true });
  const { store } = fixture;
  const filters = {
    preset: "custom",
    startDate: "2026-01-02",
    endDate: "2026-01-05",
    bucket: "day",
    calendarZone: "local",
    excludeHomes: ["home-claude", "home-dsh"],
    now: NOW,
  };
  try {
    const { actual, oracle } = await readDashboardParity(store, filters, true, {
      includeDetails: true,
    });
    assert.deepEqual(actual.metadata, oracle.metadata);
    assert.deepEqual(actual.periodComparison, oracle.periodComparison);
    assert.equal(actual.summary.range.calendarZone, "local");
    assert.equal(actual.summary.totals.total, 2000);
    assert.equal(actual.metadata.homeCount, SOURCES.length);
    assert.equal(actual.summary.repositories.length, 4);
    const repositoryOrder = actual.summary.repositories.map(({ key, sessionIds }) => ({ key, sessionIds }));
    assert.deepEqual(
      repositoryOrder,
      oracle.summary.repositories.map(({ key, sessionIds }) => ({ key, sessionIds })),
    );
    assert.ok(repositoryOrder.every(({ sessionIds }) => Array.isArray(sessionIds)));
    assert.ok(repositoryOrder.some(({ sessionIds }) => sessionIds.length > 1));
    assert.deepEqual(actual.summary, oracle.summary);
  } finally {
    fixture.close();
  }
});

test("standalone history readers match the complete dashboard oracle", { skip: !SQL_SUPPORTED }, async () => {
  const fixture = await createFixture({ archiveDays: [0, 1, 2, 3], revision: true });
  const { store } = fixture;
  const filters = {
    preset: "custom",
    startDate: "2026-01-02",
    endDate: "2026-01-05",
    bucket: "day",
    calendarZone: "local",
    excludeHomes: ["home-claude", "home-dsh"],
    now: NOW,
  };
  try {
    const originalTrySql = store.trySqlHistoryDashboard;
    store.trySqlHistoryDashboard = async () => null;
    let oracle;
    try {
      oracle = await store.dashboardHistory(filters, { includeDetails: true });
    } finally {
      store.trySqlHistoryDashboard = originalTrySql;
    }
    const originalUnion = store.historyArchiveEventUnionForRange;
    let unionCalls = 0;
    store.historyArchiveEventUnionForRange = async () => {
      unionCalls += 1;
      throw Object.assign(new Error("complete carrier fallback is forbidden"), {
        code: "CARRIER_USED",
      });
    };
    let summary;
    let metadata;
    let periodComparison;
    try {
      summary = await store.summarizeHistory(filters, { includeDetails: true });
      metadata = await store.metadataHistory(filters.now);
      periodComparison = await store.periodComparisonHistory({
        now: filters.now,
        excludeHomes: filters.excludeHomes,
        calendarZone: filters.calendarZone,
      });
    } finally {
      store.historyArchiveEventUnionForRange = originalUnion;
    }
    assert.equal(unionCalls, 0, "standalone history readers must stay on the bounded archive route");
    assert.deepEqual(metadata, oracle.metadata);
    assert.deepEqual(periodComparison, oracle.periodComparison);
    assert.deepEqual(summary, oracle.summary);
  } finally {
    fixture.close();
  }
});

test("captured history survives an external hot commit and releases the WAL", { skip: !SQL_SUPPORTED }, async () => {
  const fixture = await createFixture({ archiveDays: [0, 1, 2, 3], revision: true });
  const { store } = fixture;
  const filters = filtersFor("all");
  const originalTrySql = store.trySqlHistoryDashboard;
  store.trySqlHistoryDashboard = async () => null;
  let oldDashboard;
  try {
    oldDashboard = await store.dashboardHistory(filters, { includeDetails: false });
  } finally {
    store.trySqlHistoryDashboard = originalTrySql;
  }

  const originalFinish = UsageHistoryQuery.prototype.finish;
  let writer = null;
  let writerCommitted = false;
  let finishCalls = 0;
  let checkpoint = null;
  try {
    UsageHistoryQuery.prototype.finish = function (columns) {
      finishCalls += 1;
      if (!writerCommitted) {
        const event = {
          ...eventPayload(fixture.root, SOURCES[0], 0, 4, 1000, 100),
          timestamp_ms: START_MS + 4 * DAY_MS + 12 * 60 * 60 * 1000,
          session_id: "writer-session-写",
          project: "writer project",
          hour_key: "2026-01-05 12:00",
          detail_mask: 15,
          reconciliation_gap: 0,
          cache_write_tokens: 17,
          cache_write_known: 1,
          request_input_tokens: 1000,
          context_level: "long",
          service_tier: "priority",
          total: 1000,
          input: 900,
          cached: 100,
          output: 100,
          reasoning: 0,
        };
        writer = new DatabaseSync(store.databaseFile);
        try {
          writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
          insertRows(writer, "events", [event]);
          writer.exec("COMMIT");
          writerCommitted = true;
        } finally {
          writer.close();
          writer = null;
        }
        assert.equal(store.database.isTransaction, false, "hot capture must release its SQLite transaction");
      }
      const database = originalFinish.call(this, columns);
      if (!checkpoint) {
        assert.equal(store.database.isTransaction, false);
        checkpoint = checkpointUsageStore(store.database);
      }
      return database;
    };

    const stale = await store.dashboardHistory(filters, { includeDetails: false });
    assert.equal(writerCommitted, true);
    assert.equal(finishCalls, 1);
    assert.deepEqual(stale, oldDashboard, "the in-flight dashboard must stay on its captured hot revision");
  } catch (error) {
    fixture.close();
    throw error;
  } finally {
    UsageHistoryQuery.prototype.finish = originalFinish;
    writer?.close();
  }

  try {
    assert.ok(checkpoint);
    assert.equal(checkpoint.error, null);
    assert.equal(checkpoint.busy, 0, "no hidden reader may keep the WAL busy");
    assert.equal(store.database.isTransaction, false);

    const later = await store.dashboardHistory(filters, { includeDetails: false });
    assert.equal(later.summary.totals.total, oldDashboard.summary.totals.total + 1000);
    assert.equal(later.summary.eventCount, oldDashboard.summary.eventCount + 1);
    assert.equal(later.metadata.eventCount, oldDashboard.metadata.eventCount + 1);
  } finally {
    fixture.close();
  }
});

async function boundedFailure(store, filters) {
  const originalUnion = store.historyArchiveEventUnionForRange;
  let unionCalls = 0;
  let error;
  store.historyArchiveEventUnionForRange = async () => {
    unionCalls += 1;
    throw Object.assign(new Error("complete carrier fallback is forbidden"), {
      code: "CARRIER_USED",
    });
  };
  try {
    try {
      await store.dashboardHistory(filters, { includeDetails: false });
    } catch (caught) {
      error = caught;
    }
  } finally {
    store.historyArchiveEventUnionForRange = originalUnion;
  }
  assert.equal(unionCalls, 0, "failure must come from the bounded archive route without carrier fallback");
  assert.ok(error, "dashboard must reject instead of returning partial or empty data");
  return error;
}

test("archived dashboard verification fails closed without carrier fallback", { skip: !SQL_SUPPORTED }, async () => {
  const fixture = await createFixture({ archiveDays: [3] });
  const { store, candidateFiles } = fixture;
  const candidateFile = candidateFiles[0];
  try {
    renameSync(candidateFile, `${candidateFile}.missing`);
    try {
      assert.equal((await boundedFailure(store, filtersFor("all"))).code, "ENOENT");
    } finally {
      renameSync(`${candidateFile}.missing`, candidateFile);
    }
    await assertDashboardParity(store, filtersFor("all"), true);

    const sealed = readFileSync(candidateFile);
    const damaged = Buffer.from(sealed);
    damaged[damaged.length - 1] ^= 1;
    writeFileSync(candidateFile, damaged);
    try {
      assert.equal((await boundedFailure(store, filtersFor("all"))).code, "HISTORY_BACKUP_DIGEST_MISMATCH");
    } finally {
      writeFileSync(candidateFile, sealed);
    }
  } finally {
    fixture.close();
  }
});

test("archive revisions and source bindings fail closed without carrier fallback", {
  skip: !SQL_SUPPORTED,
}, async () => {
  const fixture = await createFixture({ archiveDays: [3] });
  const { store, archives } = fixture;
  try {
    const rows = await store.readHistoryArchiveEvents(archives[0].segment_id);
    const row = rows.find((entry) => entry.source_path === SOURCES[0].source_path);
    assert.ok(row);
    const { id: _id, ...payload } = row;
    const sourceIdentity = {
      ...store.database
        .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(SOURCES[0].source_path),
    };
    writeMeta(store, REVISION_META, {
      formatVersion: 1,
      revisions: [
        {
          segmentId: archives[0].segment_id,
          databaseSha256: archives[0].database_sha256,
          sourceIdentity,
          removed: [{ payload, count: 2 }],
          added: [],
        },
      ],
    });
    assert.equal((await boundedFailure(store, filtersFor("all"))).code, "HISTORY_ARCHIVE_REVISION_INVALID");

    store.database.prepare("DELETE FROM store_meta WHERE key = ?").run(REVISION_META);
    store.database
      .prepare("UPDATE source_files SET home_label = ? WHERE path = ?")
      .run("Changed source identity", SOURCES[0].source_path);
    assert.equal((await boundedFailure(store, filtersFor("all"))).code, "HISTORY_ARCHIVE_HOT_COLD_CONFLICT");
  } finally {
    fixture.close();
  }
});
