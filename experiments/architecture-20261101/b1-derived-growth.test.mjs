import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  allocateHomeSessions,
  assertPrepareDestinationFresh,
  assertRunDestinationFresh,
  buildCasePlan,
  buildDerivedCase,
  CASES,
  DEFAULT_OUTPUT_ROOT,
  NODE_FLAGS,
  resolveOutputRoot,
} from "./b1-derived-growth.mjs";

const DAY_MS = 86_400_000;
const EVENT_COLUMNS = [
  "id",
  "source_path",
  "timestamp_ms",
  "session_id",
  "home_id",
  "home_label",
  "channel",
  "project",
  "model",
  "hour_key",
  "day_key",
  "week_key",
  "month_key",
  "cwd",
  "repository_key",
  "repository_path",
  "repository_kind",
  "detail_mask",
  "reconciliation_gap",
  "cache_write_tokens",
  "cache_write_known",
  "request_input_tokens",
  "context_level",
  "service_tier",
  "price_version",
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
  "extra_fact",
];

function createFixtureSource(file) {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        repository_kind TEXT NOT NULL,
        detail_mask INTEGER NOT NULL,
        reconciliation_gap INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cache_write_known INTEGER NOT NULL,
        request_input_tokens INTEGER NOT NULL,
        context_level TEXT NOT NULL,
        service_tier TEXT NOT NULL,
        price_version TEXT NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        extra_fact TEXT NOT NULL
      ) STRICT;
      CREATE TABLE rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL,
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL,
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE TABLE quota_usage_sources (
        source_path TEXT NOT NULL,
        home_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        quota_source TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        PRIMARY KEY (source_path, session_id, timestamp_ms)
      ) STRICT;
      CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE archive_segments (
        segment_id TEXT PRIMARY KEY,
        database_path TEXT NOT NULL,
        database_sha256 TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        registered_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE history_replaced_facts (
        fact_table TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        payload TEXT NOT NULL,
        source_home_label TEXT NOT NULL,
        source_home_path TEXT NOT NULL,
        method_version TEXT NOT NULL,
        revision_reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (fact_table, source_kind, home_id, source_path, payload_digest)
      ) STRICT;
      CREATE TABLE usage_rollup_daily (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id)
      ) STRICT;
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
      CREATE TABLE usage_rollup_dirty_days (day_key TEXT PRIMARY KEY) STRICT;
      CREATE TABLE usage_rollup_models (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        model TEXT NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id, model)
      ) STRICT;
      CREATE TABLE usage_rollup_sessions (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id, session_id)
      ) STRICT;
    `);
    const insertSource = database.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const home of ["a", "b", "c"]) {
      insertSource.run(
        `/fixture/source-${home}`,
        "main",
        `home-${home}`,
        `Home ${home.toUpperCase()}`,
        `/fixture/home-${home}`,
        100,
        1,
        "2026-11-03",
      );
    }
    const insert = database.prepare(
      `INSERT INTO events (${EVENT_COLUMNS.join(", ")})
       VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})`,
    );
    const startMs = Date.parse("2026-07-31T17:00:00.000Z");
    for (let index = 0; index < 30; index += 1) {
      const timestamp = startMs + Math.round((index * 90 * DAY_MS) / 29);
      const home = index < 20 ? "a" : index < 28 ? "b" : "c";
      const homeSession =
        home === "a" ? `session-a-${index % 3}` : home === "b" ? `session-b-${index % 2}` : "session-c-0";
      const day = new Date(timestamp).toISOString().slice(0, 10);
      insert.run(
        index + 1,
        `/fixture/source-${home}`,
        timestamp,
        homeSession,
        `home-${home}`,
        `Home ${home.toUpperCase()}`,
        "CLI",
        "fixture",
        "gpt-test",
        `${day} 00`,
        day,
        "2026-07-27",
        day.slice(0, 7),
        "/fixture",
        "fixture",
        "/fixture",
        "directory",
        0,
        0,
        0,
        0,
        0,
        "context",
        "default",
        "v1",
        15,
        10,
        2,
        5,
        1,
        `fact-${index % 7}`,
      );
    }
    const quotaInsert = database.prepare(
      `INSERT INTO rate_limit_observations
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 9; index += 1) {
      const observed = startMs + index * 10 * DAY_MS;
      quotaInsert.run(
        "/fixture/source-a",
        index + 1,
        "primary",
        observed,
        "codex",
        "Codex",
        "pro",
        10080,
        observed + DAY_MS,
        10,
      );
    }
    database.exec(`
      INSERT INTO archive_segments VALUES ('old', '/old', 'old', 0, 1, 1, 1);
      INSERT INTO history_replaced_facts VALUES
        ('events', 'main', 'home-a', '/fixture/source-a', 'digest', 1, '{}', 'Home A', '/fixture/home-a', 'v1', 'test', 'now');
      INSERT INTO quota_usage_sources VALUES ('/fixture/source-a', 'home-a', 'session-a-0', 1, 'plan', 2);
      INSERT INTO usage_rollup_daily VALUES ('local', '2026-08-01', 'home-a', 1);
      INSERT INTO usage_rollup_days VALUES ('utc', '2026-08-01', 0, 1);
      INSERT INTO usage_rollup_dirty_days VALUES ('2026-08-01');
      INSERT INTO usage_rollup_models VALUES ('local', '2026-08-01', 'home-a', 'gpt-test');
      INSERT INTO usage_rollup_sessions VALUES ('local', '2026-08-01', 'home-a', 'session-a-0');
      INSERT INTO store_meta VALUES ('official_quota_observations', 'stale');
      INSERT INTO store_meta VALUES ('quota_source_log_evidence', 'stale');
      INSERT INTO store_meta VALUES ('usage_file_fingerprints', 'stale');
      INSERT INTO store_meta VALUES ('generated_at', 'old');
    `);
  } finally {
    database.close();
  }
}

function readStats(database) {
  const stats = database
    .prepare(
      `SELECT
         COUNT(*) AS events,
         COUNT(DISTINCT home_id || char(0) || session_id) AS sessions,
         COUNT(DISTINCT session_id) AS distinct_session_ids,
         MIN(timestamp_ms) AS min_ms,
         MAX(timestamp_ms) AS max_ms,
         SUM(total) AS total,
         SUM(input) AS input,
         SUM(cached) AS cached,
         SUM(output) AS output,
         SUM(reasoning) AS reasoning
       FROM events`,
    )
    .get();
  return {
    events: Number(stats.events),
    sessions: Number(stats.sessions),
    distinctSessionIds: Number(stats.distinct_session_ids),
    minMs: Number(stats.min_ms),
    maxMs: Number(stats.max_ms),
    total: Number(stats.total),
    input: Number(stats.input),
    cached: Number(stats.cached),
    output: Number(stats.output),
    reasoning: Number(stats.reasoning),
  };
}

function assertLocalCalendarKeys(database) {
  const mismatches = database
    .prepare(
      `SELECT COUNT(*) AS value
       FROM events
       WHERE hour_key != strftime('%Y-%m-%d %H', timestamp_ms / 1000, 'unixepoch', '+8 hours')
          OR day_key != strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch', '+8 hours')
          OR week_key != date(
            timestamp_ms / 1000,
            'unixepoch',
            '+8 hours',
            '-' || (
              (CAST(strftime('%w', timestamp_ms / 1000, 'unixepoch', '+8 hours') AS INTEGER) + 6) % 7
            ) || ' days'
          )
          OR month_key != strftime('%Y-%m', timestamp_ms / 1000, 'unixepoch', '+8 hours')`,
    )
    .get().value;
  assert.equal(mismatches, 0);
}

function sourceEventPayload(database) {
  const changedColumns = new Set(["session_id", "hour_key", "day_key", "week_key", "month_key"]);
  const stableColumns = EVENT_COLUMNS.filter((column) => !changedColumns.has(column));
  return database
    .prepare(
      `SELECT ${stableColumns.join(", ")}
       FROM events
       ORDER BY id`,
    )
    .all();
}

test("production cases fix 146412 events and 71153 quota while growing only session cardinality", () => {
  assert.equal(CASES.length, 5);
  assert.deepEqual(
    CASES.map((entry) => [entry.id, entry.mode, entry.expectedEvents, entry.expectedSessions, entry.expectedQuota]),
    [
      ["01-session-growth-1729", "session-growth", 146_412, 1_729, 71_153],
      ["02-session-growth-8645", "session-growth", 146_412, 8_645, 71_153],
      ["03-session-growth-17290", "session-growth", 146_412, 17_290, 71_153],
      ["04-12mo-facts-derived", "calendar-density", 593_782, 7_012, 288_565],
      ["05-24mo-facts-derived", "calendar-density", 1_187_564, 14_024, 577_130],
    ],
  );
  for (const entry of CASES) {
    assert.match(entry.label, /facts-DB derived diagnostic/i);
  }
});

test("configured Node heap flags spawn successfully", () => {
  assert.deepEqual(NODE_FLAGS, ["--max-old-space-size=224", "--max-semi-space-size=4"]);
  const child = spawnSync(
    process.execPath,
    [
      ...NODE_FLAGS,
      "-e",
      "process.stdout.write(process.execArgv.includes('--max-semi-space-size=4') ? 'ok' : 'missing')",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "ok");
});

test("B1_DERIVED_LABEL selects one safe child directory and defaults to the current location", () => {
  assert.equal(resolveOutputRoot({}), DEFAULT_OUTPUT_ROOT);
  assert.equal(resolveOutputRoot({ B1_DERIVED_LABEL: "fix-2" }), path.join(DEFAULT_OUTPUT_ROOT, "fix-2"));
  for (const label of ["", "Fix-2", "../fix", "fix_2", "fix/2"]) {
    assert.throws(() => resolveOutputRoot({ B1_DERIVED_LABEL: label }), /B1_DERIVED_LABEL/);
  }
});

test("prepare and run refuse destinations containing prior evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "b1-evidence-guard-"));
  try {
    await assertPrepareDestinationFresh(root);
    const manifest = path.join(root, "manifest.json");
    await writeFile(manifest, "keep-manifest", { flag: "wx" });
    await assert.rejects(assertPrepareDestinationFresh(root), /manifest already exists/);
    assert.equal(await readFile(manifest, "utf8"), "keep-manifest");
    await rm(manifest);

    const caseDirectory = path.join(root, "case");
    await mkdir(caseDirectory);
    await assertRunDestinationFresh(caseDirectory);
    for (const name of ["measurement-child.json", "restart-child.json", "result.json"]) {
      const evidence = path.join(caseDirectory, name);
      await writeFile(evidence, name, { flag: "wx" });
      await assert.rejects(assertRunDestinationFresh(caseDirectory), /run evidence already exists/);
      assert.equal(await readFile(evidence, "utf8"), name);
      await rm(evidence);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("home session allocation caps a crowded home and redistributes the deficit", () => {
  const allocation = allocateHomeSessions(
    [
      { homeId: "a", eventCount: 5, sessionCount: 2 },
      { homeId: "b", eventCount: 20, sessionCount: 1 },
      { homeId: "c", eventCount: 10, sessionCount: 1 },
    ],
    15,
  );
  assert.deepEqual(
    allocation.map((home) => [home.homeId, home.targetSessions]),
    [
      ["a", 5],
      ["b", 5],
      ["c", 5],
    ],
  );
  for (const home of allocation) assert.ok(home.targetSessions <= home.eventCount);
});

test("tiny session-growth case changes only session and local calendar keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "b1-session-growth-"));
  try {
    const source = path.join(root, "source.sqlite");
    const expanded = path.join(root, "expanded.sqlite");
    createFixtureSource(source);

    const sourceDatabase = new DatabaseSync(source, { readOnly: true });
    const base = readStats(sourceDatabase);
    const beforeEvents = sourceEventPayload(sourceDatabase);
    const beforeQuota = sourceDatabase
      .prepare("SELECT * FROM rate_limit_observations ORDER BY source_path, line_number")
      .all();
    let plan;
    try {
      plan = buildCasePlan({ ...base, quota: 9 }, "test-session", {
        id: "test-session",
        label: "tiny session growth",
        mode: "session-growth",
        days: 90,
        expectedEvents: base.events,
        expectedSessions: 12,
        expectedQuota: 9,
      });
    } finally {
      sourceDatabase.close();
    }
    assert.equal(plan.targetEvents, 30);
    assert.equal(plan.targetQuota, 9);

    const built = await buildDerivedCase({
      sourceFile: source,
      outputFile: expanded,
      caseId: "test-session",
      caseSpec: {
        id: "test-session",
        label: "tiny session growth",
        mode: "session-growth",
        days: 90,
        expectedEvents: base.events,
        expectedSessions: 12,
        expectedQuota: 9,
      },
    });
    assert.equal(built.expected.events, 30);
    assert.equal(built.expected.sessions, 12);
    assert.equal(built.expected.quota, 9);
    assert.deepEqual(
      built.homeSessions.map((home) => [home.homeId, home.targetSessions]),
      [
        ["home-a", 6],
        ["home-b", 4],
        ["home-c", 2],
      ],
    );

    const database = new DatabaseSync(expanded, { readOnly: true });
    try {
      const stats = readStats(database);
      assert.equal(stats.events, base.events);
      assert.equal(stats.sessions, 12);
      assert.equal(stats.distinctSessionIds, 12);
      assert.equal(stats.total, base.total);
      assert.equal(stats.input, base.input);
      assert.equal(stats.cached, base.cached);
      assert.equal(stats.output, base.output);
      assert.equal(stats.reasoning, base.reasoning);
      assert.equal(stats.minMs, base.minMs);
      assert.equal(stats.maxMs, base.maxMs);
      assert.deepEqual(sourceEventPayload(database), beforeEvents);
      assert.deepEqual(
        database.prepare("SELECT * FROM rate_limit_observations ORDER BY source_path, line_number").all(),
        beforeQuota,
      );
      assertLocalCalendarKeys(database);
      assert.ok(
        database
          .prepare(
            `SELECT COUNT(*) AS value FROM events
             WHERE day_key != strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch')`,
          )
          .get().value > 0,
      );
      assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tiny 12-month density case scales daily counts and keeps all fact columns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "b1-derived-density-"));
  try {
    const source = path.join(root, "source.sqlite");
    const expanded = path.join(root, "expanded.sqlite");
    createFixtureSource(source);

    const sourceDb = new DatabaseSync(source, { readOnly: true });
    const base = readStats(sourceDb);
    sourceDb.close();
    const expectedCount = Math.round((base.events * 365) / 90);
    const expectedQuota = Math.round((9 * 365) / 90);
    const expectedSessions = Math.round((base.sessions * 365) / 90);
    const fullCopies = Math.floor(expectedCount / base.events);
    const remainder = expectedCount % base.events;
    const partial = new DatabaseSync(source, { readOnly: true });
    const partialTotals = partial
      .prepare(
        `WITH source AS (SELECT total, input, cached, output, reasoning FROM events ORDER BY id LIMIT ?)
         SELECT SUM(total) total, SUM(input) input, SUM(cached) cached,
                SUM(output) output, SUM(reasoning) reasoning
         FROM source`,
      )
      .get(remainder);
    partial.close();

    const built = await buildDerivedCase({
      sourceFile: source,
      outputFile: expanded,
      caseId: "test-12mo",
      caseSpec: {
        id: "test-12mo",
        label: "12-month daily-density facts-DB derived diagnostic",
        mode: "calendar-density",
        days: 365,
        expectedEvents: expectedCount,
        expectedSessions,
        expectedQuota,
      },
    });
    assert.equal(built.expected.events, expectedCount);
    assert.equal(built.expected.sessions, expectedSessions);
    assert.equal(built.expected.quota, expectedQuota);
    assert.equal(built.expected.measurementScope, "facts-db-derived-only");
    assert.equal(built.expected.endToEnd, false);

    const database = new DatabaseSync(expanded, { readOnly: true });
    try {
      const stats = readStats(database);
      assert.equal(stats.events, expectedCount);
      assert.equal(stats.sessions, expectedSessions);
      assert.equal(stats.distinctSessionIds, expectedSessions);
      for (const field of ["total", "input", "cached", "output", "reasoning"]) {
        assert.equal(stats[field], base[field] * fullCopies + Number(partialTotals[field] ?? 0));
      }
      assert.equal(stats.maxMs, base.maxMs);
      assert.equal(stats.minMs, base.maxMs - 365 * DAY_MS);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS value FROM rate_limit_observations").get().value,
        expectedQuota,
      );
      assert.deepEqual(
        database
          .prepare("SELECT DISTINCT extra_fact FROM events ORDER BY extra_fact")
          .all()
          .map((row) => row.extra_fact),
        ["fact-0", "fact-1", "fact-2", "fact-3", "fact-4", "fact-5", "fact-6"],
      );
      assertLocalCalendarKeys(database);
      for (const table of [
        "archive_segments",
        "history_replaced_facts",
        "quota_usage_sources",
        "usage_rollup_daily",
        "usage_rollup_days",
        "usage_rollup_dirty_days",
        "usage_rollup_models",
        "usage_rollup_sessions",
      ]) {
        assert.equal(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value, 0, table);
      }
      assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
