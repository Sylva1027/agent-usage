import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { normalizePerfSample, PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

const ARCHIVE_START_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const ARCHIVE_END_MS = ARCHIVE_START_MS + 60_000;
const ARCHIVE_OUTSIDE_MS = ARCHIVE_END_MS;
const ARCHIVE_READ_END_MS = ARCHIVE_OUTSIDE_MS + 60_000;
const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";

const FACT_TABLES = Object.freeze([
  "source_files",
  "events",
  "rate_limit_observations",
  "history_replaced_facts",
  "perf_samples",
  "perf_sample_sources",
  "perf_rollout_threads",
  "perf_codex_projections",
  "workbuddy_generation_durations",
  "workbuddy_generation_duration_observations",
  "perf_request_timing_meta",
  "perf_request_timing_evidence",
  "perf_request_timing_threads",
  "perf_request_timing_dirty_threads",
]);

function newStore(root, databaseFile) {
  return new UsageStore({
    homeDir: root,
    databaseFile,
    importDirs: [],
  });
}

function snapshotFacts(database) {
  return Object.fromEntries(
    FACT_TABLES.map((table) => [
      table,
      database
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
}

async function makeSchema20Fixture(root, databaseFile) {
  const store = newStore(root, databaseFile);
  await store.open();
  try {
    assert.equal(
      store.database.prepare("PRAGMA user_version").get().user_version,
      STORE_SCHEMA_VERSION,
      "the source fixture starts at the current store schema before it is manually downgraded",
    );
    store.database.exec(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES ('rollout.jsonl', 'codex', 'home', 'Home', '/home', 10, 1.5, '2026-10-22T00:00:00.000Z');
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (
        'rollout.jsonl', 1770000000000, 'session', 'home', 'Home', 'main', '/work', 'gpt-test',
        '2027-02-02 03:00', '2027-02-02', '2027-W06', '2027-02', 10, 7, 2, 3, 1
      );
      INSERT INTO history_replaced_facts (
        fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
        source_home_label, source_home_path, method_version, revision_reason, recorded_at
      ) VALUES (
        'events', 'codex', 'home', 'rollout.jsonl', 'digest', 2, '{"total":10}',
        'Home', '/home', 'events.v1', 'reparse_replaced', '2026-10-22T00:00:00.000Z'
      );
    `);
    return snapshotFacts(store.database);
  } finally {
    store.close();
  }
}

function downgradeTo20(databaseFile) {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("DROP TABLE archive_segments; PRAGMA user_version = 20;");
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 20);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'archive_segments'").get().count,
      0,
    );
  } finally {
    database.close();
  }
}

function seedArchiveFacts(database, root, { duplicateInRange = false, extraInRange = false } = {}) {
  const sourcePath = path.join(root, "source.jsonl");
  database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
  const insertEvent = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEvent.run(
    sourcePath,
    ARCHIVE_START_MS,
    "in-range",
    "home",
    "Home",
    "main",
    "project",
    "gpt-test",
    "hour",
    "day",
    "week",
    "month",
    20,
    18,
    0,
    2,
    0,
  );
  if (duplicateInRange) {
    insertEvent.run(
      sourcePath,
      ARCHIVE_START_MS,
      "in-range",
      "home",
      "Home",
      "main",
      "project",
      "gpt-test",
      "hour",
      "day",
      "week",
      "month",
      20,
      18,
      0,
      2,
      0,
    );
  }
  if (extraInRange) {
    insertEvent.run(
      sourcePath,
      ARCHIVE_START_MS + 30_000,
      "in-range-extra",
      "home",
      "Home",
      "main",
      "project",
      "gpt-test",
      "hour",
      "day",
      "week",
      "month",
      5,
      4,
      0,
      1,
      0,
    );
  }
  insertEvent.run(
    sourcePath,
    ARCHIVE_OUTSIDE_MS,
    "outside-range",
    "home",
    "Home",
    "main",
    "project",
    "gpt-test",
    "hour",
    "day",
    "week",
    "month",
    10,
    9,
    0,
    1,
    0,
  );
  database
    .prepare(
      `INSERT INTO history_replaced_facts (
        fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
        source_home_label, source_home_path, method_version, revision_reason, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "events",
      "codex",
      "home",
      sourcePath,
      "digest",
      1,
      '{"sample":"old-event"}',
      "Home",
      root,
      "events.v1",
      "reparse",
      "2026-01-02T03:05:00.000Z",
    );
}

function seedArchiveRecordFacts(database, root) {
  const sourcePath = path.join(root, "record-source.jsonl");
  const excludedPath = path.join(root, "record-excluded.jsonl");
  const insertSource = database.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertSource.run(sourcePath, "extra", "home", "Home", root, 1, 1, "2026-07-20T00:00:00.000Z");
  insertSource.run(excludedPath, "extra", "excluded-home", "Excluded", root, 1, 1, "2026-07-20T00:00:00.000Z");
  const insertEvent = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDay = (source, day, total, homeId, homeLabel) => {
    const date = new Date(`${day}T02:00:00.000Z`);
    const week = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10);
    insertEvent.run(
      source,
      date.getTime(),
      `record-${homeId}-${day}`,
      homeId,
      homeLabel,
      "main",
      "project",
      "gpt-6-sol",
      `${day} 02:00`,
      day,
      week,
      day.slice(0, 7),
      total,
      total - 1,
      0,
      1,
      0,
    );
  };
  insertDay(sourcePath, "2026-07-12", 900, "home", "Home");
  for (const day of ["13", "14", "15", "16", "17", "18", "19"]) {
    insertDay(sourcePath, `2026-07-${day}`, 200, "home", "Home");
  }
  insertDay(excludedPath, "2026-07-12", 10_000, "excluded-home", "Excluded");
}

function seedArchiveQuotaRecordFacts(database, root) {
  const homeSource = path.join(root, "quota-home.jsonl");
  const bonusSource = path.join(root, "quota-bonus.jsonl");
  const projectSource = path.join(root, "quota-project.jsonl");
  const insertSource = database.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertSource.run(homeSource, "codex", "home", "Home", root, 1, 1, "2026-09-26T12:00:00.000Z");
  insertSource.run(bonusSource, "extra", "bonus", "Bonus", root, 1, 1, "2026-09-26T12:00:00.000Z");
  insertSource.run(projectSource, "project-log", "project", "Project", root, 1, 1, "2026-09-26T12:00:00.000Z");
  const insertEvent = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEventAt = (source, timestamp, sessionId, homeId, homeLabel, model, total) => {
    const date = new Date(timestamp);
    const day = date.toISOString().slice(0, 10);
    const week = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10);
    insertEvent.run(
      source,
      timestamp,
      sessionId,
      homeId,
      homeLabel,
      "main",
      "project",
      model,
      `${day} ${String(date.getUTCHours()).padStart(2, "0")}:00`,
      day,
      week,
      day.slice(0, 7),
      total,
      total - 1,
      0,
      1,
      0,
    );
  };
  insertEventAt(homeSource, Date.parse("2026-09-24T09:00:00.000Z"), "cold-start", "home", "Home", "gpt-6-sol", 20);
  insertEventAt(homeSource, Date.parse("2026-09-24T10:00:00.000Z"), "cold-main", "home", "Home", "gpt-6-sol", 100);
  insertEventAt(homeSource, Date.parse("2026-09-24T13:59:59.999Z"), "cold-end", "home", "Home", "gpt-6-sol", 30);
  insertEventAt(homeSource, Date.parse("2026-09-24T14:00:00.000Z"), "cold-outside", "home", "Home", "gpt-6-sol", 9999);
  insertEventAt(homeSource, Date.parse("2026-09-25T10:00:00.000Z"), "hot-previous", "home", "Home", "gpt-6-sol", 200);
  insertEventAt(homeSource, Date.parse("2026-09-26T10:00:00.000Z"), "hot-current", "home", "Home", "gpt-6-sol", 500);
  insertEventAt(bonusSource, Date.parse("2026-09-26T10:15:00.000Z"), "hot-bonus", "bonus", "Bonus", "gpt-6-sol", 700);
  insertEventAt(
    projectSource,
    Date.parse("2026-09-26T10:30:00.000Z"),
    "hot-project",
    "project",
    "Project",
    "gpt-6-luna",
    10_000,
  );
  const insertObservation = database.prepare(`
    INSERT INTO rate_limit_observations (
      source_path, line_number, role, observed_at_ms, limit_id, limit_name,
      plan_type, window_minutes, resets_at_ms, used_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, day] of [24, 25, 26].entries()) {
    insertObservation.run(
      homeSource,
      index + 1,
      "primary",
      Date.parse(`2026-09-${day}T10:00:00.000Z`),
      "codex",
      null,
      null,
      300,
      Date.parse(`2026-09-${day}T14:00:00.000Z`),
      42 + index,
    );
  }
}

function insertArchiveEvent(database, root, timestampMs, sessionId, total, id = null) {
  database
    .prepare(
      `INSERT INTO events (
        id, source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      path.join(root, "source.jsonl"),
      timestampMs,
      sessionId,
      "home",
      "Home",
      "main",
      "project",
      "gpt-test",
      "hour",
      "day",
      "week",
      "month",
      total,
      total - 1,
      0,
      1,
      0,
    );
}

async function makeV20ArchiveSource(root, databaseFile, options) {
  const store = newStore(root, databaseFile);
  await store.open();
  try {
    seedArchiveFacts(store.database, root, options);
  } finally {
    store.close();
  }
  downgradeTo20(databaseFile);
}

async function createCandidate(sourceFile, destinationFile, startMs, endMs) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await createHistoryArchiveCandidate(source, destinationFile, { startMs, endMs });
  } finally {
    source.close();
  }
  return verifyHistoryArchiveCandidate(destinationFile);
}

function archiveDirectory(store) {
  return JSON.stringify(store.database.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all());
}

function snapshotMeta(database) {
  return JSON.stringify(database.prepare("SELECT * FROM store_meta ORDER BY key").all());
}

function writeArchiveAuthority(database, authority) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(ARCHIVE_AUTHORITY_META, typeof authority === "string" ? authority : JSON.stringify(authority));
}

function rawEventRows(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare("SELECT * FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function canonicalEventPayload(row) {
  return JSON.stringify(
    Object.keys(row)
      .filter((key) => key !== "id")
      .sort()
      .map((key) => [key, row[key]]),
  );
}

function codexTokenLine(timestamp, total, lastTotal) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 20,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          total_tokens: lastTotal,
          input_tokens: lastTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

function codexSessionPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cumulative-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
  ].join("\n");
}

function codexCumulativePrefix(codexHome, timestamp, total) {
  return `${codexSessionPrefix(codexHome)}\n${codexTokenLine(timestamp, total, total)}`;
}

function makePerfSample(sourcePath, identity, timestampMs, outputTokens) {
  const normalized = normalizePerfSample({
    sourceKind: "zcode",
    identity: [identity],
    homeId: "home",
    sourcePath,
    channel: "zcode",
    agentKind: "unknown",
    agent: "",
    sessionId: "perf-session",
    turnKey: "",
    model: "gpt-6-sol",
    modelProvider: "",
    reasoningEffort: "",
    modelEvidence: "",
    status: "completed",
    tsMs: timestampMs,
    windowStartMs: timestampMs,
    windowEndMs: timestampMs + 1_000,
    durationMs: 1_000,
    outputTokens,
    requestCount: 1,
  });
  assert.ok(normalized.sample, JSON.stringify(normalized.warnings));
  return normalized.sample;
}

function seedPerfState(store, samples) {
  for (const sample of samples) store.insertPerfSample(sample);
  store.writePerfState("ready");
  store.writeMeta("perf_method_version", PERF_METHOD_VERSION);
  store.writeMeta("perf_index_version", "perf-index-before");
  store.writeMeta("perf_indexed_at", "2026-07-20T00:00:00.000Z");
}

function referenceEventUnion(hotRows, coldRows) {
  const counts = new Map();
  const rows = new Map();
  // Hot and cold are copies of the same range; max preserves multiplicity without double-counting.
  for (const side of [hotRows, coldRows]) {
    const sideCounts = new Map();
    for (const row of side) {
      const payload = canonicalEventPayload(row);
      sideCounts.set(payload, (sideCounts.get(payload) ?? 0) + 1);
      rows.set(payload, rows.get(payload) ?? row);
    }
    for (const [payload, count] of sideCounts) {
      counts.set(payload, Math.max(counts.get(payload) ?? 0, count));
    }
  }
  return [...counts]
    .sort(
      ([left], [right]) =>
        rows.get(left).timestamp_ms - rows.get(right).timestamp_ms || (left < right ? -1 : left > right ? 1 : 0),
    )
    .flatMap(([payload, count]) => Array.from({ length: count }, () => ({ ...rows.get(payload) })));
}

test("schema 20 migrates to the current schema while preserving facts and an empty archive directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  try {
    const before = await makeSchema20Fixture(root, databaseFile);
    downgradeTo20(databaseFile);

    const store = newStore(root, databaseFile);
    try {
      await store.open();
      assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
      const after = snapshotFacts(store.database);
      assert.deepEqual(
        after,
        {
          ...before,
          source_files: before.source_files.map((row) => ({ ...row, size: -1, mtime_ms: -1 })),
        },
        "v22 may only mark existing sources dirty; every fact row and source ownership field must survive",
      );
      assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a schema 21 marker migrates to current and current-schema reopening stays idempotent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  try {
    const first = newStore(root, databaseFile);
    await first.open();
    assert.equal(first.database.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
    first.close();

    const legacy = new DatabaseSync(databaseFile);
    try {
      legacy.exec("PRAGMA user_version = 21;");
      assert.equal(legacy.prepare("PRAGMA user_version").get().user_version, 21);
    } finally {
      legacy.close();
    }

    const migrated = newStore(root, databaseFile);
    try {
      await migrated.open();
      assert.equal(migrated.database.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
      assert.equal(
        migrated.database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'")
          .get().count,
        1,
      );
      assert.equal(migrated.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 0);
    } finally {
      migrated.close();
    }

    const reopened = newStore(root, databaseFile);
    try {
      await reopened.open();
      assert.equal(reopened.database.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
      assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("archive_segments has the frozen STRICT columns and CHECK constraints", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  const store = newStore(root, databaseFile);
  try {
    await store.open();
    const columns = store.database
      .prepare("PRAGMA table_info(archive_segments)")
      .all()
      .map((row) => ({
        name: String(row.name),
        type: String(row.type),
        notnull: Number(row.notnull),
        pk: Number(row.pk),
      }));
    assert.deepEqual(columns, [
      { name: "segment_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "database_path", type: "TEXT", notnull: 1, pk: 0 },
      { name: "database_sha256", type: "TEXT", notnull: 1, pk: 0 },
      { name: "start_ms", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "end_ms", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "event_count", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "registered_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
    ]);
    const ddl = String(
      store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'").get()
        .sql,
    );
    assert.ok(ddl.includes("STRICT"));
    assert.ok(ddl.includes("CHECK (end_ms > start_ms)"));
    assert.ok(ddl.includes("CHECK (event_count >= 0)"));

    const insert = store.database.prepare("INSERT INTO archive_segments VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("sha256:segment", "segments/one.sqlite", "sha256:database", 10, 20, 0, 30);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 1);
    assert.throws(
      () => insert.run("sha256:empty-span", "segments/two.sqlite", "sha256:database", 10, 10, 1, 30),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("sha256:negative", "segments/three.sqlite", "sha256:database", 10, 20, -1, 30),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("sha256:segment", "segments/duplicate.sqlite", "sha256:database", 20, 30, 1, 40),
      /UNIQUE constraint failed/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("registers one verified candidate idempotently without changing hot facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    const verified = await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const before = snapshotFacts(store.database);

    const first = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(first.inserted, true);
    assert.equal(first.segmentId, verified.manifest.database.sha256);
    assert.equal(first.databaseSha256, verified.manifest.database.sha256);
    assert.equal(first.databasePath, path.resolve(candidateFile));
    assert.equal(first.startMs, ARCHIVE_START_MS);
    assert.equal(first.endMs, ARCHIVE_END_MS);
    assert.equal(first.eventCount, 1);
    assert.ok(Number.isSafeInteger(first.registeredAtMs));
    assert.deepEqual(snapshotFacts(store.database), before);

    const second = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(second.inserted, false);
    assert.equal(second.registeredAtMs, first.registeredAtMs);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 1);
    assert.deepEqual(snapshotFacts(store.database), before);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reads one registered archive segment without changing hot facts or directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_READ_END_MS);
    const expected = rawEventRows(candidateFile);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);

    const rows = await store.readHistoryArchiveEvents(registered.segmentId);
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      expected,
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    await assert.rejects(
      store.readHistoryArchiveEvents("0".repeat(64)),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("hot and cold union oracle keeps mirrored facts once and rejects a missing segment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);

    const hotRows = store.database
      .prepare("SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id")
      .all(ARCHIVE_START_MS, ARCHIVE_END_MS)
      .map((row, index) => ({ ...row, id: 100 + index }));
    const coldRows = (await store.readHistoryArchiveEvents(registered.segmentId)).map((row, index) => ({
      ...row,
      id: 900 + index,
    }));
    assert.equal(hotRows.length, 1);
    assert.equal(coldRows.length, 1);
    assert.deepEqual(referenceEventUnion(hotRows, coldRows), [hotRows[0]]);

    const hotDuplicates = [hotRows[0], { ...hotRows[0], id: 200 }];
    const coldDuplicates = [coldRows[0], { ...coldRows[0], id: 901 }];
    assert.equal(referenceEventUnion(hotDuplicates, coldDuplicates).length, 2);
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    rmSync(candidateFile);
    await assert.rejects(
      async () => referenceEventUnion([], await store.readHistoryArchiveEvents(registered.segmentId)),
      (error) => error.code === "ENOENT",
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("range merge checks the full registered segment and preserves duplicate multiplicity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root, { duplicateInRange: true, extraInRange: true });
    await makeV20ArchiveSource(root, sourceFile, { duplicateInRange: true, extraInRange: true });
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);

    const request = { startMs: ARCHIVE_START_MS, endMs: ARCHIVE_START_MS + 10_000 };
    const merged = await store.mergeHistoryArchiveEventsForRange(request);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].session_id, "in-range");
    assert.equal(merged[1].session_id, "in-range");
    assert.equal(
      merged.some((row) => row.session_id === "in-range-extra"),
      false,
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    const withUnregisteredRange = await store.mergeHistoryArchiveEventsForRange({
      startMs: ARCHIVE_START_MS,
      endMs: ARCHIVE_OUTSIDE_MS + 1,
    });
    assert.equal(withUnregisteredRange.length, 4);
    assert.equal(withUnregisteredRange.at(-1).session_id, "outside-range");

    await assert.rejects(store.mergeHistoryArchiveEventsForRange({ startMs: 1.5, endMs: ARCHIVE_END_MS }), TypeError);

    store.database.prepare("UPDATE events SET total = total + 1 WHERE session_id = ?").run("in-range-extra");
    const payloadChangedFacts = snapshotFacts(store.database);
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange(request),
      (error) => error.code === "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
    );
    assert.deepEqual(snapshotFacts(store.database), payloadChangedFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    store.database.prepare("UPDATE events SET total = total - 1 WHERE session_id = ?").run("in-range-extra");
    store.database
      .prepare("UPDATE source_files SET home_label = ? WHERE path = ?")
      .run("Changed Home", path.join(root, "source.jsonl"));
    const identityChangedFacts = snapshotFacts(store.database);
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange(request),
      (error) => error.code === "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
    );
    assert.deepEqual(snapshotFacts(store.database), identityChangedFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    store.database
      .prepare("UPDATE source_files SET home_label = ? WHERE path = ?")
      .run("Home", path.join(root, "source.jsonl"));
    const beforeMissing = snapshotFacts(store.database);
    rmSync(candidateFile);
    await assert.rejects(store.mergeHistoryArchiveEventsForRange(request), (error) => error.code === "ENOENT");
    await assert.rejects(store.publishedHistoryUsageEvents(), (error) => error.code === "ENOENT");
    await assert.rejects(store.publishedHistoryUsageReport(), (error) => error.code === "ENOENT");
    assert.deepEqual(snapshotFacts(store.database), beforeMissing);
    assert.equal(archiveDirectory(store), beforeDirectory);
    assert.equal(registered.eventCount, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("range merge unions two registered segments with a hot gap and rejects a missing second segment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const firstSource = path.join(root, "first-source.sqlite");
  const secondSource = path.join(root, "second-source.sqlite");
  const firstCandidate = path.join(root, "first-candidate.sqlite");
  const secondCandidate = path.join(root, "second-candidate.sqlite");
  const secondSegmentStart = ARCHIVE_START_MS + 40_000;
  const secondSegmentEnd = ARCHIVE_START_MS + 60_000;
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root, { duplicateInRange: true });
    insertArchiveEvent(store.database, root, ARCHIVE_START_MS + 50_000, "second-segment", 6, 6);
    insertArchiveEvent(store.database, root, ARCHIVE_START_MS + 30_000, "hot-gap", 7);

    await makeV20ArchiveSource(root, firstSource, { duplicateInRange: true });
    await makeV20ArchiveSource(root, secondSource);
    const secondDatabase = new DatabaseSync(secondSource);
    try {
      insertArchiveEvent(secondDatabase, root, ARCHIVE_START_MS + 50_000, "second-segment", 6, 6);
    } finally {
      secondDatabase.close();
    }

    await createCandidate(firstSource, firstCandidate, ARCHIVE_START_MS, ARCHIVE_START_MS + 20_000);
    await createCandidate(secondSource, secondCandidate, secondSegmentStart, secondSegmentEnd);
    await store.registerHistoryArchiveCandidate(firstCandidate);
    const secondRegistered = await store.registerHistoryArchiveCandidate(secondCandidate);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);

    const merged = await store.mergeHistoryArchiveEventsForRange({
      startMs: ARCHIVE_START_MS,
      endMs: secondSegmentEnd,
    });
    assert.equal(merged.length, 4);
    assert.deepEqual(
      merged.map((row) => row.session_id),
      ["in-range", "in-range", "hot-gap", "second-segment"],
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    rmSync(secondRegistered.databasePath);
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({
        startMs: ARCHIVE_START_MS,
        endMs: secondSegmentEnd,
      }),
      (error) => error.code === "ENOENT",
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("authorized cold segments answer range reads across a hot gap with original duplicate payloads", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const firstSource = path.join(root, "first-source.sqlite");
  const secondSource = path.join(root, "second-source.sqlite");
  const firstCandidate = path.join(root, "first-candidate.sqlite");
  const secondCandidate = path.join(root, "second-candidate.sqlite");
  const secondSegmentStart = ARCHIVE_START_MS + 40_000;
  const secondSegmentEnd = ARCHIVE_START_MS + 60_000;
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root, { duplicateInRange: true });
    insertArchiveEvent(store.database, root, ARCHIVE_START_MS + 30_000, "hot-gap", 7);
    insertArchiveEvent(store.database, root, ARCHIVE_START_MS + 50_000, "second-segment", 6, 40);
    insertArchiveEvent(store.database, root, ARCHIVE_START_MS + 70_000, "after-segments", 8);

    await makeV20ArchiveSource(root, firstSource, { duplicateInRange: true });
    await makeV20ArchiveSource(root, secondSource);
    const secondDatabase = new DatabaseSync(secondSource);
    try {
      insertArchiveEvent(secondDatabase, root, ARCHIVE_START_MS + 50_000, "second-segment", 6, 40);
    } finally {
      secondDatabase.close();
    }

    await createCandidate(firstSource, firstCandidate, ARCHIVE_START_MS, ARCHIVE_START_MS + 20_000);
    await createCandidate(secondSource, secondCandidate, secondSegmentStart, secondSegmentEnd);
    const firstRegistered = await store.registerHistoryArchiveCandidate(firstCandidate);
    const secondRegistered = await store.registerHistoryArchiveCandidate(secondCandidate);
    const firstCold = rawEventRows(firstCandidate);
    const secondCold = rawEventRows(secondCandidate);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, {
        formatVersion: 1,
        segmentIds: [firstRegistered.segmentId, secondRegistered.segmentId],
      });
      store.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(ARCHIVE_START_MS, ARCHIVE_START_MS + 20_000);
      store.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(secondSegmentStart, secondSegmentEnd);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);
    const beforeMeta = snapshotMeta(store.database);
    const merged = await store.mergeHistoryArchiveEventsForRange({
      startMs: ARCHIVE_START_MS,
      endMs: ARCHIVE_START_MS + 80_000,
    });

    assert.deepEqual(
      merged.map((row) => row.session_id),
      ["in-range", "in-range", "hot-gap", "second-segment", "outside-range", "after-segments"],
    );
    assert.deepEqual(merged.slice(0, 2).map(canonicalEventPayload), firstCold.map(canonicalEventPayload));
    assert.deepEqual(merged.slice(3, 4).map(canonicalEventPayload), secondCold.map(canonicalEventPayload));
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
    assert.equal(snapshotMeta(store.database), beforeMeta);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("periodComparisonHistory without authority keeps the cached hot-only path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const store = newStore(root, path.join(root, "usage-index.sqlite"));
  const originalPeriodComparison = store.periodComparison;
  const originalHistoryEvents = store.publishedHistoryUsageEvents;
  let delegated = 0;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    store.periodComparison = function (options) {
      delegated += 1;
      return originalPeriodComparison.call(this, options);
    };
    store.publishedHistoryUsageEvents = async () => {
      throw new Error("cold carrier must not run without authority");
    };
    const options = { now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" };
    const first = await store.periodComparisonHistory(options);
    const second = await store.periodComparisonHistory(options);

    assert.equal(delegated, 2);
    assert.equal(store.periodComparisonCache.size, 1);
    assert.deepEqual(second, first);
    assert.equal(second.totals.all.total, 30);
  } finally {
    store.periodComparison = originalPeriodComparison;
    store.publishedHistoryUsageEvents = originalHistoryEvents;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("summarizeHistory without authority keeps the synchronous hot-only summary", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const store = newStore(root, path.join(root, "usage-index.sqlite"));
  const originalHistoryReport = store.publishedHistoryUsageReport;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    store.publishedHistoryUsageReport = async () => {
      throw new Error("cold carrier must not run without authority");
    };
    const filters = { preset: "all", now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" };
    const expected = store.summarize(filters);
    const actual = await store.summarizeHistory(filters);

    assert.deepEqual(actual, expected);
    assert.equal(actual.totals.total, 30);
  } finally {
    store.publishedHistoryUsageReport = originalHistoryReport;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("metadataHistory without authority keeps the synchronous hot-only metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const store = newStore(root, path.join(root, "usage-index.sqlite"));
  const originalHistoryUnion = store.historyArchiveEventUnionForRange;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    store.historyArchiveEventUnionForRange = async () => {
      throw new Error("cold carrier must not run without authority");
    };
    const asOf = new Date("2026-01-02T04:00:00.000Z");
    const expected = store.metadata(asOf);
    const actual = await store.metadataHistory(asOf);

    assert.deepEqual(actual, expected);
    assert.equal(actual.eventCount, 2);
  } finally {
    store.historyArchiveEventUnionForRange = originalHistoryUnion;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("summarizeHistory pins the no-authority marker and hot summary against an external commit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourcePath = path.join(root, "source.jsonl");
  const store = newStore(root, liveFile);
  let writer;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  try {
    await store.open();
    writer = new DatabaseSync(liveFile);
    seedArchiveFacts(store.database, root);
    insertArchiveEvent(store.database, root, ARCHIVE_READ_END_MS + 1_000, "race-extra", 100);
    store.database
      .prepare(
        `INSERT INTO rate_limit_observations (
          source_path, line_number, role, observed_at_ms, limit_id, limit_name,
          plan_type, window_minutes, resets_at_ms, used_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sourcePath, 1, "primary", ARCHIVE_START_MS, "codex", null, null, 300, ARCHIVE_START_MS + 18_000_000, 11);

    DatabaseSync.prototype.prepare = function patchedPrepare(sql, ...args) {
      const statement = originalPrepare.call(this, sql, ...args);
      if (this !== store.database || !String(sql).includes("SELECT 1 FROM store_meta WHERE key IN (?, ?)"))
        return statement;
      return {
        get(...params) {
          const result = statement.get(...params);
          if (!injected) {
            injected = true;
            writer.exec("BEGIN IMMEDIATE");
            try {
              writeArchiveAuthority(writer, { formatVersion: 1, segmentIds: [] });
              writer
                .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
                .run(ARCHIVE_START_MS, ARCHIVE_END_MS);
              writer
                .prepare("UPDATE rate_limit_observations SET used_percent = 22 WHERE source_path = ?")
                .run(sourcePath);
              writer.exec("COMMIT");
            } catch (error) {
              writer.exec("ROLLBACK");
              throw error;
            }
          }
          return result;
        },
      };
    };

    const filters = { preset: "all", now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" };
    const pinned = await store.summarizeHistory(filters);
    assert.equal(injected, true);
    assert.equal(pinned.totals.total, 130);
    assert.equal(pinned.quota.windows.quota_5h.usedPercent, 11);

    const hotAfter = store.summarize(filters);
    assert.equal(hotAfter.totals.total, 110);
    assert.equal(hotAfter.quota.windows.quota_5h.usedPercent, 22);

    const coldAfter = await store.summarizeHistory(filters);
    assert.equal(coldAfter.totals.total, 110);
    assert.equal(coldAfter.perf.state, "uninitialized");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    writer?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("summarizeHistory records match an unarchived store for cold champions, exclusions and range boundaries", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const sourceFile = path.join(root, "record-source.sqlite");
  const candidateFile = path.join(root, "record-candidate.sqlite");
  const store = newStore(root, path.join(root, "archived.sqlite"));
  const oracle = newStore(root, path.join(root, "oracle.sqlite"));
  const sourceStore = newStore(root, sourceFile);
  try {
    await store.open();
    await oracle.open();
    seedArchiveRecordFacts(store.database, root);
    seedArchiveRecordFacts(oracle.database, root);
    try {
      await sourceStore.open();
      seedArchiveRecordFacts(sourceStore.database, root);
    } finally {
      sourceStore.close();
    }
    downgradeTo20(sourceFile);
    await createCandidate(
      sourceFile,
      candidateFile,
      Date.parse("2026-07-12T00:00:00.000Z"),
      Date.parse("2026-07-20T00:00:00.000Z"),
    );
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database.prepare("DELETE FROM events").run();
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const base = {
      preset: "custom",
      now: "2026-07-20T00:00:00.000Z",
      bucket: "day",
      calendarZone: "utc",
    };
    for (const [filters, expected] of [
      [
        { ...base, startDate: "2026-07-12", endDate: "2026-07-12" },
        { unit: "day", period: "2026-07-12", value: 10900 },
      ],
      [
        { ...base, startDate: "2026-07-12", endDate: "2026-07-12", excludeHomes: ["excluded-home"] },
        { unit: "day", period: "2026-07-12", value: 900 },
      ],
      [
        { ...base, startDate: "2026-07-13", endDate: "2026-07-19", excludeHomes: ["excluded-home"] },
        { unit: "week", period: "2026-07-13", value: 1400 },
      ],
      [{ ...base, startDate: "2026-07-14", endDate: "2026-07-19", excludeHomes: ["excluded-home"] }, null],
    ]) {
      const history = await store.summarizeHistory(filters);
      const expectedRecords = oracle.summarize(filters).records;
      assert.deepEqual(history.records, expectedRecords);
      if (expected) {
        assert.deepEqual(
          {
            unit: history.records.totalTokens.unit,
            period: history.records.totalTokens.period,
            value: history.records.totalTokens.value,
          },
          expected,
        );
      } else {
        assert.equal(history.records.totalTokens, undefined);
      }
    }
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("summarizeHistory captures perf with the carrier before cold reads", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const sourceFile = path.join(root, "record-source.sqlite");
  const candidateFile = path.join(root, "perf-candidate.sqlite");
  const liveFile = path.join(root, "archived.sqlite");
  const sourcePath = path.join(root, "record-source.jsonl");
  const store = newStore(root, liveFile);
  const oracle = newStore(root, path.join(root, "oracle.sqlite"));
  const sourceStore = newStore(root, sourceFile);
  try {
    await store.open();
    await oracle.open();
    seedArchiveRecordFacts(store.database, root);
    seedArchiveRecordFacts(oracle.database, root);
    try {
      await sourceStore.open();
      seedArchiveRecordFacts(sourceStore.database, root);
    } finally {
      sourceStore.close();
    }
    downgradeTo20(sourceFile);
    await createCandidate(
      sourceFile,
      candidateFile,
      Date.parse("2026-07-12T00:00:00.000Z"),
      Date.parse("2026-07-20T00:00:00.000Z"),
    );
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database.prepare("DELETE FROM events").run();
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const before = makePerfSample(sourcePath, "before", Date.parse("2026-07-12T02:00:00.000Z"), 100);
    const outside = makePerfSample(sourcePath, "outside", Date.parse("2026-07-20T02:00:00.000Z"), 200);
    const after = makePerfSample(sourcePath, "after", Date.parse("2026-07-12T03:00:00.000Z"), 300);
    seedPerfState(store, [before, outside]);
    seedPerfState(oracle, [before, outside]);
    const filters = {
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-12",
      now: "2026-07-20T00:00:00.000Z",
      calendarZone: "utc",
    };
    const expectedBefore = oracle.summarize(filters).perf;
    assert.equal(expectedBefore.coverage.eligible, 1);
    assert.equal(expectedBefore.groups[0].n, 1);

    const originalReadSnapshot = store.readHistoryArchiveSnapshot.bind(store);
    let injected = false;
    store.readHistoryArchiveSnapshot = async (record) => {
      if (!injected) {
        injected = true;
        const writer = newStore(root, liveFile);
        await writer.open();
        try {
          writer.insertPerfSample(after);
          writer.writePerfState("ready");
          writer.writeMeta("perf_method_version", PERF_METHOD_VERSION);
          writer.writeMeta("perf_index_version", "perf-index-after");
          writer.writeMeta("perf_indexed_at", "2026-07-20T01:00:00.000Z");
        } finally {
          writer.close();
        }
      }
      return originalReadSnapshot(record);
    };

    const first = await store.summarizeHistory(filters);
    assert.equal(injected, true);
    assert.deepEqual(first.perf, expectedBefore);

    oracle.insertPerfSample(after);
    oracle.writeMeta("perf_method_version", PERF_METHOD_VERSION);
    oracle.writeMeta("perf_index_version", "perf-index-after");
    oracle.writeMeta("perf_indexed_at", "2026-07-20T01:00:00.000Z");
    const expectedWithAfter = oracle.summarize(filters).perf;
    const second = await store.summarizeHistory(filters);

    assert.deepEqual(second.perf, expectedWithAfter);
    assert.equal(second.perf.indexVersion, "perf-index-after");
    assert.equal(second.perf.coverage.eligible, 2);
    assert.equal(second.perf.groups[0].n, 2);
    assert.equal(second.perf.groups[0].sums.outputTokens, 400);
    assert.notDeepEqual(first.perf, second.perf);
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("summarizeHistory quota records match an unarchived store across cold and hot windows", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const sourceFile = path.join(root, "quota-record-source.sqlite");
  const candidateFile = path.join(root, "quota-record-candidate.sqlite");
  const store = newStore(root, path.join(root, "archived.sqlite"));
  const oracle = newStore(root, path.join(root, "oracle.sqlite"));
  const sourceStore = newStore(root, sourceFile);
  try {
    await store.open();
    await oracle.open();
    seedArchiveQuotaRecordFacts(store.database, root);
    seedArchiveQuotaRecordFacts(oracle.database, root);
    try {
      await sourceStore.open();
      seedArchiveQuotaRecordFacts(sourceStore.database, root);
    } finally {
      sourceStore.close();
    }
    downgradeTo20(sourceFile);
    await createCandidate(
      sourceFile,
      candidateFile,
      Date.parse("2026-09-24T00:00:00.000Z"),
      Date.parse("2026-09-25T00:00:00.000Z"),
    );
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(Date.parse("2026-09-24T00:00:00.000Z"), Date.parse("2026-09-25T00:00:00.000Z"));
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const filters = {
      preset: "quota_5h",
      bucket: "quota_30m",
      now: "2026-09-26T12:00:00.000Z",
    };
    const history = await store.summarizeHistory(filters);
    assert.deepEqual(history.records, oracle.summarize(filters).records);
    assert.deepEqual(
      {
        value: history.records.totalTokens.value,
        comparedWindowCount: history.records.totalTokens.comparedWindowCount,
      },
      { value: 1200, comparedWindowCount: 2 },
    );

    const excludedFilters = { ...filters, excludeHomes: ["bonus"] };
    const excludedHistory = await store.summarizeHistory(excludedFilters);
    assert.deepEqual(excludedHistory.records, oracle.summarize(excludedFilters).records);
    assert.equal(excludedHistory.records.totalTokens.value, 500);

    rmSync(candidateFile);
    await assert.rejects(store.summarizeHistory(filters), (error) => error.code === "ENOENT");
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("periodComparisonHistory pins the no-authority marker and period read against an external commit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  let writer;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  try {
    await store.open();
    writer = new DatabaseSync(liveFile);
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    insertArchiveEvent(store.database, root, ARCHIVE_OUTSIDE_MS + 1_000, "race-extra", 100);

    DatabaseSync.prototype.prepare = function patchedPrepare(sql, ...args) {
      const statement = originalPrepare.call(this, sql, ...args);
      if (this !== store.database || !String(sql).includes("SELECT 1 FROM store_meta WHERE key = ?")) return statement;
      return {
        get(...params) {
          const result = statement.get(...params);
          if (!injected) {
            injected = true;
            writer.exec("BEGIN IMMEDIATE");
            try {
              writeArchiveAuthority(writer, { formatVersion: 1, segmentIds: [registered.segmentId] });
              writer
                .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
                .run(ARCHIVE_START_MS, ARCHIVE_END_MS);
              writer.exec("COMMIT");
            } catch (error) {
              writer.exec("ROLLBACK");
              throw error;
            }
          }
          return result;
        },
      };
    };

    const options = { now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" };
    const first = await store.periodComparisonHistory(options);
    assert.equal(injected, true);
    assert.equal(first.totals.all.total, 130);
    assert.equal(store.periodComparisonCache.size, 1);

    // The pinned result used the pre-commit revision; a later hot-only read must
    // detect the external commit instead of reusing that snapshot from the memo.
    const hotOnly = store.periodComparison(options);
    assert.equal(hotOnly.totals.all.total, 110);

    const second = await store.periodComparisonHistory(options);
    assert.deepEqual(second, first);
    assert.equal(second.totals.all.total, 130);
    assert.equal(store.periodComparisonCache.size, 1);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    writer?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("authorized cold reads reject residual hot facts, changed sources, invalid authority and bad packages", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const originalFile = path.join(root, "candidate-original.sqlite");
  const sourcePath = path.join(root, "source.jsonl");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    copyFileSync(candidateFile, originalFile);
    const cold = rawEventRows(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => error.code === "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
    );

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(ARCHIVE_START_MS, ARCHIVE_END_MS);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const authorized = await store.mergeHistoryArchiveEventsForRange({
      startMs: ARCHIVE_START_MS,
      endMs: ARCHIVE_END_MS,
    });
    assert.deepEqual(authorized.map(canonicalEventPayload), cold.map(canonicalEventPayload));

    store.database.prepare("UPDATE source_files SET home_label = ? WHERE path = ?").run("Changed Home", sourcePath);
    const changedSourceFacts = snapshotFacts(store.database);
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => error.code === "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
    );
    assert.deepEqual(snapshotFacts(store.database), changedSourceFacts);
    store.database.prepare("UPDATE source_files SET home_label = ? WHERE path = ?").run("Home", sourcePath);

    rmSync(candidateFile);
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      store.periodComparisonHistory({ now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" }),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      store.summarizeHistory({ preset: "all", now: "2026-01-02T04:00:00.000Z", calendarZone: "utc" }),
      (error) => error.code === "ENOENT",
    );
    copyFileSync(originalFile, candidateFile);

    const tampered = new DatabaseSync(candidateFile);
    try {
      tampered.prepare("UPDATE events SET total = total + 1 WHERE id = (SELECT MIN(id) FROM events)").run();
    } finally {
      tampered.close();
    }
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => String(error.code).startsWith("HISTORY_BACKUP_"),
    );

    writeArchiveAuthority(store.database, { formatVersion: 2, segmentIds: [registered.segmentId] });
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => error.code === "HISTORY_ARCHIVE_AUTHORITY_INVALID",
    );

    writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: ["0".repeat(64)] });
    await assert.rejects(
      store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("authorized cold plus Codex cumulative delta matches an unarchived source oracle", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cumulative.jsonl");
  const candidateFile = path.join(root, "cumulative-candidate.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const firstTimestampMs = Date.parse(firstTimestamp);
  const secondTimestampMs = Date.parse(secondTimestamp);
  const options = { homeDir: root, env: {}, extraHomes: codexHome };
  const prefixFor = (total) => codexCumulativePrefix(codexHome, firstTimestamp, total);
  const prefix = prefixFor(100);
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${prefix}\n`);
    await store.sync({ options });
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: firstTimestampMs,
      endMs: secondTimestampMs,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`);
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });
    await oracle.sync({ options });

    const coldStart = new Date(firstTimestampMs);
    const coldMetadata = await store.metadataHistory(coldStart);
    const oracleMetadata = oracle.metadata(coldStart);
    assert.equal(typeof coldMetadata.generatedAt, "string");
    assert.deepEqual({ ...coldMetadata, generatedAt: oracleMetadata.generatedAt }, oracleMetadata);
    assert.equal(coldMetadata.modelLastSeen.Codex["gpt-6-luna"], firstTimestampMs);
    const candidateBackup = path.join(root, "candidate-backup.sqlite");
    copyFileSync(candidateFile, candidateBackup);
    rmSync(candidateFile);
    await assert.rejects(store.metadataHistory(coldStart), (error) => error.code === "ENOENT");
    copyFileSync(candidateBackup, candidateFile);

    const range = { startMs: firstTimestampMs, endMs: secondTimestampMs + 1 };
    const hotTotals = () =>
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total));
    assert.deepEqual(hotTotals(), [30]);
    const expected = oracle.database
      .prepare("SELECT * FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    const expectedTotal = expected.reduce((sum, row) => sum + Number(row.total), 0);
    const publishedTotal = oracle.publishedUsageEvents().reduce((sum, row) => sum + Number(row.total.total), 0);
    assert.equal(publishedTotal, expectedTotal);
    assert.equal(expectedTotal, 130);
    let merged;
    try {
      merged = await store.mergeHistoryArchiveEventsForRange(range);
    } catch (error) {
      const hot = store.database
        .prepare(
          "SELECT timestamp_ms, total FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms",
        )
        .all(firstTimestampMs, secondTimestampMs + 1);
      assert.fail(
        `${error.code}: ${error.message}; hot=${JSON.stringify(hot)}; oracle=${JSON.stringify(
          expected.map((row) => Number(row.total)),
        )}; oracleTotal=${expectedTotal}`,
      );
    }
    const mergedTotal = merged.reduce((sum, row) => sum + Number(row.total), 0);
    const noOp = await store.sync({ options });
    const noOpMerged = await store.mergeHistoryArchiveEventsForRange(range);

    assert.equal(noOp.updatedFileCount, 0);
    assert.deepEqual(hotTotals(), [30]);
    assert.equal(noOpMerged.length, merged.length);
    assert.deepEqual(merged.map(canonicalEventPayload), expected.map(canonicalEventPayload));
    assert.equal(mergedTotal, expectedTotal);

    const periodOptions = { now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" };
    const expectedPublished = oracle.publishedUsageEvents();
    const actualHistoryPublished = await store.publishedHistoryUsageEvents();
    assert.deepEqual(actualHistoryPublished, expectedPublished);
    assert.deepEqual(
      actualHistoryPublished.map((event) => event.total.total),
      [100, 30],
    );
    assert.deepEqual(
      actualHistoryPublished.map((event) => event.sourceKind),
      ["extra", "extra"],
    );

    const actualPublished = store.publishedUsageEvents();
    const actualPeriodComparison = await store.periodComparisonHistory(periodOptions);
    const expectedPeriodComparison = oracle.periodComparison(periodOptions);
    assert.deepEqual(
      actualPeriodComparison,
      expectedPeriodComparison,
      "history period comparison differs from the unarchived oracle",
    );
    assert.deepEqual(
      actualPublished.map((event) => event.total.total),
      [30],
    );
    assert.equal(store.periodComparison(periodOptions).totals.all.total, 30);
    assert.equal(actualPeriodComparison.totals.month.total, 130);
    assert.equal(actualPeriodComparison.totals.all.total, 130);

    const archiveHomeId = oracle.publishedUsageHomes()[0].id;
    for (const comparisonOptions of [
      { ...periodOptions, calendarZone: "local" },
      { ...periodOptions, excludeHomes: [archiveHomeId] },
    ]) {
      assert.deepEqual(
        await store.periodComparisonHistory(comparisonOptions),
        oracle.periodComparison(comparisonOptions),
      );
    }

    const summaryOptions = { preset: "all", now: periodOptions.now, calendarZone: "utc" };
    for (const comparisonOptions of [summaryOptions, { ...summaryOptions, excludeHomes: [archiveHomeId] }]) {
      const historySummary = await store.summarizeHistory(comparisonOptions);
      const oracleSummary = oracle.summarize(comparisonOptions);
      const historyUsage = { ...historySummary };
      const oracleUsage = { ...oracleSummary };
      for (const deferred of ["generatedAt", "records"]) {
        delete historyUsage[deferred];
        delete oracleUsage[deferred];
      }
      historyUsage.perf.indexedAt = "";
      oracleUsage.perf.indexedAt = "";
      historyUsage.perf.meta.indexedAt = "";
      oracleUsage.perf.meta.indexedAt = "";
      assert.deepEqual(historyUsage, oracleUsage);
      assert.deepEqual(oracleSummary.records, {});
    }
    const compactSummary = await store.summarizeHistory(summaryOptions, { includeDetails: false });
    assert.equal(compactSummary.totals.total, 130);
    assert.equal(compactSummary.homes, undefined);
    assert.equal(compactSummary.projects, undefined);
    assert.equal(compactSummary.repositories, undefined);

    const sealedBytes = readFileSync(candidateFile);
    const assertAcceptedRevision = async (contents) => {
      writeFileSync(usageFile, contents);
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      oracle.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options });
      await oracle.sync({ options });
      assert.deepEqual(await store.publishedHistoryUsageEvents(), oracle.publishedUsageEvents());
      assert.deepEqual(readFileSync(candidateFile), sealedBytes);
      assert.ok(
        store.database.prepare("SELECT value FROM store_meta WHERE key = 'history_archive_event_revisions'").get(),
      );
    };
    await assertAcceptedRevision(`${prefixFor(110)}\n${codexTokenLine(secondTimestamp, 130, 20)}\n`);
    await assertAcceptedRevision(
      `${prefixFor(100)}\n${codexTokenLine("2026-07-12T02:00:30.000Z", 110, 10)}\n${codexTokenLine(
        secondTimestamp,
        130,
        20,
      )}\n`,
    );

    const eventsBeforeRejectedReparse = store.database
      .prepare("SELECT * FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    const replacedFactsBeforeRejectedReparse = store.database
      .prepare("SELECT * FROM history_replaced_facts ORDER BY fact_table, source_path, payload_digest")
      .all()
      .map((row) => ({ ...row }));
    const sourceIdentityBeforeRejectedReparse = store.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
      .all();
    const directoryBeforeRejectedReparse = store.database
      .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
      .all();
    const authorityBeforeRejectedReparse = store.database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(ARCHIVE_AUTHORITY_META)?.value;
    const assertRejectedWithoutStateChange = async (contents) => {
      writeFileSync(usageFile, contents);
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options });
      assert.ok(
        store.warnings.some((warning) => warning.includes("removes or migrates cold events in authorized segment")),
      );
      assert.deepEqual(
        store.database
          .prepare("SELECT * FROM events ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
        eventsBeforeRejectedReparse,
      );
      assert.deepEqual(
        store.database
          .prepare("SELECT * FROM history_replaced_facts ORDER BY fact_table, source_path, payload_digest")
          .all()
          .map((row) => ({ ...row })),
        replacedFactsBeforeRejectedReparse,
      );
      assert.deepEqual(
        store.database
          .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
          .all(),
        sourceIdentityBeforeRejectedReparse,
      );
      assert.deepEqual(
        store.database.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all(),
        directoryBeforeRejectedReparse,
      );
      assert.equal(
        store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(ARCHIVE_AUTHORITY_META)?.value,
        authorityBeforeRejectedReparse,
      );
    };
    await assertRejectedWithoutStateChange(
      `${codexSessionPrefix(codexHome)}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`,
    );
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("publishedHistoryUsageEvents matches an unarchived source oracle across cold and hot facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cumulative.jsonl");
  const candidateFile = path.join(root, "cumulative-candidate.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${codexCumulativePrefix(codexHome, firstTimestamp, 100)}\n`);
    await store.sync({ options });
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeArchiveAuthority(store.database, { formatVersion: 1, segmentIds: [registered.segmentId] });
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(
      usageFile,
      `${codexCumulativePrefix(codexHome, firstTimestamp, 100)}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`,
    );
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });
    await oracle.sync({ options });

    const actual = await store.publishedHistoryUsageEvents();
    const expected = oracle.publishedUsageEvents();
    assert.deepEqual(actual, expected);
    assert.deepEqual(
      actual.map((event) => event.total.total),
      [100, 30],
    );
    assert.deepEqual(
      actual.map((event) => event.timestamp),
      [firstTimestamp, secondTimestamp],
    );
    assert.deepEqual(
      actual.map((event) => event.sourceKind),
      ["extra", "extra"],
    );
    const actualReport = await store.publishedHistoryUsageReport();
    assert.deepEqual(actualReport, oracle.publishedUsageReport());
    assert.deepEqual(
      actualReport.sessions.map(({ id, eventCount, total }) => ({ id, eventCount, total })),
      [
        {
          id: "cumulative-session",
          eventCount: 2,
          total: { total: 130, input: 110, cached: 0, output: 20, reasoning: 0 },
        },
      ],
    );
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("publishedHistoryUsageEvents captures bounds and hot rows in one snapshot", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const store = newStore(root, liveFile);
  let writer;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    const oldSnapshot = await store.publishedHistoryUsageEvents();
    const beforeBounds = store.database
      .prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events")
      .get();

    writer = new DatabaseSync(liveFile);
    const originalPrepare = store.database.prepare.bind(store.database);
    let injected = false;
    store.database.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (
        !injected &&
        String(sql).includes("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events")
      ) {
        const get = statement.get.bind(statement);
        return {
          get: (...args) => {
            const bounds = get(...args);
            injected = true;
            insertArchiveEvent(writer, root, Number(beforeBounds.maximum) + 86_400_000, "after-bounds", 9);
            return bounds;
          },
        };
      }
      return statement;
    };

    let interleaved;
    try {
      interleaved = await store.publishedHistoryUsageEvents();
    } finally {
      store.database.prepare = originalPrepare;
      writer.close();
      writer = undefined;
    }
    const newSnapshot = await store.publishedHistoryUsageEvents();

    assert.equal(injected, true);
    assert.deepEqual(interleaved, oldSnapshot);
    assert.equal(newSnapshot.length, oldSnapshot.length + 1);
    assert.equal(newSnapshot.at(-1).sessionId, "after-bounds");
  } finally {
    writer?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("publishedHistoryUsageReport captures homes and quota before cold reads", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const archiveSource = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const secondSource = path.join(root, "hot-source.jsonl");
  const store = newStore(root, liveFile);
  let writer;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(secondSource, "project-log", "second-home", "Second Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    const secondEventInsertSql = `
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertSecondEvent = store.database.prepare(secondEventInsertSql);
    insertSecondEvent.run(
      secondSource,
      ARCHIVE_READ_END_MS + 10_000,
      "second-session",
      "second-home",
      "Second Home",
      "main",
      "project",
      "gpt-test",
      "hour",
      "day",
      "week",
      "month",
      5,
      4,
      0,
      1,
      0,
    );
    store.database
      .prepare(
        `INSERT INTO rate_limit_observations (
          source_path, line_number, role, observed_at_ms, limit_id, limit_name,
          plan_type, window_minutes, resets_at_ms, used_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(secondSource, 1, "primary", ARCHIVE_READ_END_MS, "codex", null, null, 300, ARCHIVE_READ_END_MS, 11);

    await makeV20ArchiveSource(root, archiveSource);
    await createCandidate(archiveSource, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    await store.registerHistoryArchiveCandidate(candidateFile);

    const before = await store.publishedHistoryUsageReport();
    const originalReadSnapshot = store.readHistoryArchiveSnapshot.bind(store);
    let injected = false;
    store.readHistoryArchiveSnapshot = async (record) => {
      if (!injected) {
        injected = true;
        writer = new DatabaseSync(liveFile);
        writer.exec("BEGIN IMMEDIATE");
        try {
          writer.prepare("UPDATE source_files SET home_label = 'Second Home Changed' WHERE path = ?").run(secondSource);
          writer
            .prepare("UPDATE events SET home_label = 'Second Home Changed' WHERE source_path = ?")
            .run(secondSource);
          writer
            .prepare("UPDATE rate_limit_observations SET used_percent = 22 WHERE source_path = ?")
            .run(secondSource);
          writer
            .prepare(secondEventInsertSql)
            .run(
              secondSource,
              ARCHIVE_READ_END_MS + 20_000,
              "second-session",
              "second-home",
              "Second Home Changed",
              "main",
              "project",
              "gpt-test",
              "hour",
              "day",
              "week",
              "month",
              7,
              6,
              0,
              1,
              0,
            );
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        } finally {
          writer.close();
          writer = undefined;
        }
      }
      return originalReadSnapshot(record);
    };

    let snapshot;
    try {
      snapshot = await store.publishedHistoryUsageReport();
    } finally {
      store.readHistoryArchiveSnapshot = originalReadSnapshot;
    }
    const after = await store.publishedHistoryUsageReport();

    assert.equal(injected, true);
    assert.deepEqual(snapshot, before);
    assert.equal(after.homes.find((home) => home.id === "second-home").label, "Second Home Changed");
    assert.equal(after.rateLimitObservations[0].usedPercent, 22);
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.sessions.find((session) => session.id === "second-session").eventCount, 2);
  } finally {
    writer?.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Codex cumulative full replacement without authority keeps both hot facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cumulative.jsonl");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "unarchived.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${codexCumulativePrefix(codexHome, firstTimestamp, 100)}\n`);
    await store.sync({ options });
    writeFileSync(
      usageFile,
      `${codexCumulativePrefix(codexHome, firstTimestamp, 100)}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`,
    );
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });

    const rows = store.database.prepare("SELECT total FROM events ORDER BY timestamp_ms").all();
    assert.deepEqual(
      rows.map((row) => Number(row.total)),
      [100, 30],
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 0);
    assert.equal(
      store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(ARCHIVE_AUTHORITY_META),
      undefined,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("union keeps the captured registry record and rejects a cold rewrite before its first read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const missingFile = path.join(root, "missing-candidate.sqlite");
  const store = newStore(root, liveFile);
  const originalExec = DatabaseSync.prototype.exec;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);
    let registryInjected = false;

    DatabaseSync.prototype.exec = function patchedRegistryExec(sql, ...args) {
      const result = originalExec.call(this, sql, ...args);
      if (
        !registryInjected &&
        this === store.database &&
        String(sql).trim().toUpperCase() === "RELEASE HISTORY_ARCHIVE_UNION_READ"
      ) {
        registryInjected = true;
        store.database
          .prepare("UPDATE archive_segments SET database_path = ? WHERE segment_id = ?")
          .run(missingFile, registered.segmentId);
      }
      return result;
    };
    try {
      const merged = await store.mergeHistoryArchiveEventsForRange({
        startMs: ARCHIVE_START_MS,
        endMs: ARCHIVE_END_MS,
      });
      assert.equal(merged.length, 1);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(registryInjected, true);
    store.database
      .prepare("UPDATE archive_segments SET database_path = ? WHERE segment_id = ?")
      .run(candidateFile, registered.segmentId);
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    let rewriteInjected = false;
    let coldBegins = 0;
    DatabaseSync.prototype.exec = function patchedRewriteExec(sql, ...args) {
      const result = originalExec.call(this, sql, ...args);
      if (String(sql).trim().toUpperCase() === "BEGIN" && this !== store.database) coldBegins += 1;
      // Rewrite after the first digest, before the shared transaction pins and rechecks the bytes.
      if (
        !rewriteInjected &&
        coldBegins === 1 &&
        String(sql).trim().toUpperCase() === "BEGIN" &&
        this !== store.database
      ) {
        rewriteInjected = true;
        const tampered = new DatabaseSync(candidateFile);
        try {
          tampered.prepare("UPDATE events SET total = total + 1 WHERE id = (SELECT MIN(id) FROM events)").run();
        } finally {
          tampered.close();
        }
      }
      return result;
    };
    try {
      await assert.rejects(
        store.mergeHistoryArchiveEventsForRange({ startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS }),
        (error) => error.code === "HISTORY_BACKUP_DIGEST_MISMATCH",
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(rewriteInjected, true);
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("snapshot verification rejects a same-row rewrite before candidate validation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  const originalExec = DatabaseSync.prototype.exec;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);
    let injected = false;
    let coldBegins = 0;

    DatabaseSync.prototype.exec = function patchedExec(sql, ...args) {
      const result = originalExec.call(this, sql, ...args);
      if (String(sql).trim().toUpperCase() === "BEGIN" && this !== store.database) coldBegins += 1;
      // Rewrite after the first digest, before the shared transaction pins and rechecks the bytes.
      if (!injected && coldBegins === 1 && String(sql).trim().toUpperCase() === "BEGIN" && this !== store.database) {
        injected = true;
        const tampered = new DatabaseSync(candidateFile);
        try {
          tampered.prepare("UPDATE events SET total = total + 1 WHERE id = (SELECT MIN(id) FROM events)").run();
        } finally {
          tampered.close();
        }
      }
      return result;
    };
    try {
      await assert.rejects(
        store.readHistoryArchiveEvents(registered.segmentId),
        (error) => error.code === "HISTORY_BACKUP_DIGEST_MISMATCH",
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }

    assert.equal(injected, true);
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("cold snapshot validates and reads under one SQLite read lock", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-read-lock-"));
  const sourceFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, path.join(root, "live.sqlite"));
  const prepare = DatabaseSync.prototype.prepare;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const expected = await store.readHistoryArchiveEvents(registered.segmentId);
    let eventReads = 0;
    let writeAttempted = false;
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      const eventScan =
        sql === "SELECT * FROM events ORDER BY id" ||
        sql === "SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id";
      if (eventScan && ++eventReads === 1) {
        writeAttempted = true;
        const writer = new DatabaseSync(candidateFile);
        try {
          writer.exec("PRAGMA busy_timeout = 0");
          assert.throws(() => writer.exec("UPDATE events SET total = total + 1"), /locked/);
        } finally {
          writer.close();
        }
      }
      return statement;
    };
    assert.deepEqual(await store.readHistoryArchiveEvents(registered.segmentId), expected);
    assert.equal(writeAttempted, true);
    assert.equal(eventReads, 1, "a warm byte-bound proof still pins the actual row read against writers");
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("archive array reads preserve every SQLite value and both compatibility fallbacks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-array-"));
  const sourceFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, path.join(root, "live.sqlite"));
  const prepare = DatabaseSync.prototype.prepare;
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    const source = new DatabaseSync(sourceFile);
    try {
      for (const database of [store.database, source]) {
        database.exec(
          "ALTER TABLE events ADD COLUMN array_nullable TEXT; ALTER TABLE events ADD COLUMN \"__proto__\" TEXT DEFAULT 'safe'",
        );
      }
    } finally {
      source.close();
    }
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    const cold = new DatabaseSync(candidateFile, { readOnly: true });
    let expected;
    try {
      expected = cold.prepare("SELECT * FROM events ORDER BY id").all();
    } finally {
      cold.close();
    }
    const range = { startMs: ARCHIVE_START_MS, endMs: ARCHIVE_END_MS };
    const hotExpected = store.database
      .prepare("SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id")
      .all(range.startMs, range.endMs)
      .map((row) => ({ ...row }));
    let missing = "";
    let arrayReads = 0;
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      if (String(sql).includes("SELECT * FROM events")) {
        const native = statement.setReturnArrays;
        if (typeof native === "function") {
          statement.setReturnArrays = function (...options) {
            arrayReads += 1;
            return native.apply(this, options);
          };
        }
        if (missing) statement[missing] = undefined;
      }
      return statement;
    };
    assert.deepEqual(await store.readHistoryArchiveEvents(registered.segmentId), expected);
    assert.deepEqual(await store.mergeHistoryArchiveEventsForRange(range), hotExpected);
    const probe = prepare.call(store.database, "SELECT 1");
    if (typeof probe.setReturnArrays === "function" && typeof probe.columns === "function") assert.ok(arrayReads > 0);
    for (missing of ["setReturnArrays", "columns"]) {
      assert.deepEqual(await store.readHistoryArchiveEvents(registered.segmentId), expected);
      assert.deepEqual(await store.mergeHistoryArchiveEventsForRange(range), hotExpected);
    }
    assert.equal(expected[0].array_nullable, null);
    assert.equal(Object.getOwnPropertyDescriptor(expected[0], "__proto__").value, "safe");
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("missing or tampered archive segments are rejected without changing hot facts or directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const originalFile = path.join(root, "candidate-original.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_START_MS, ARCHIVE_END_MS);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    copyFileSync(candidateFile, originalFile);
    const beforeFacts = snapshotFacts(store.database);
    const beforeDirectory = archiveDirectory(store);

    rmSync(candidateFile);
    await assert.rejects(store.readHistoryArchiveEvents(registered.segmentId), (error) => error.code === "ENOENT");
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);

    copyFileSync(originalFile, candidateFile);
    const tampered = new DatabaseSync(candidateFile);
    try {
      tampered.prepare("UPDATE events SET total = total + 1 WHERE id = (SELECT MIN(id) FROM events)").run();
    } finally {
      tampered.close();
    }
    await assert.rejects(store.readHistoryArchiveEvents(registered.segmentId), (error) =>
      String(error.code).startsWith("HISTORY_BACKUP_"),
    );
    assert.deepEqual(snapshotFacts(store.database), beforeFacts);
    assert.equal(archiveDirectory(store), beforeDirectory);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("source changes and overlapping segments are rejected without changing the directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const firstCandidate = path.join(root, "candidate-one.sqlite");
  const overlappingCandidate = path.join(root, "candidate-two.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, firstCandidate, ARCHIVE_START_MS, ARCHIVE_END_MS);
    await store.registerHistoryArchiveCandidate(firstCandidate);
    const before = archiveDirectory(store);

    store.database.prepare("UPDATE events SET total = total + 1 WHERE timestamp_ms = ?").run(ARCHIVE_START_MS);
    await assert.rejects(
      store.registerHistoryArchiveCandidate(firstCandidate),
      (error) => error.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    assert.equal(archiveDirectory(store), before);

    store.database.prepare("UPDATE events SET total = total - 1 WHERE timestamp_ms = ?").run(ARCHIVE_START_MS);
    store.database
      .prepare("UPDATE source_files SET home_label = ? WHERE path = ?")
      .run("Changed Home", path.join(root, "source.jsonl"));
    await assert.rejects(
      store.registerHistoryArchiveCandidate(firstCandidate),
      (error) => error.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    assert.equal(archiveDirectory(store), before);

    store.database
      .prepare("UPDATE source_files SET home_label = ? WHERE path = ?")
      .run("Home", path.join(root, "source.jsonl"));
    await createCandidate(sourceFile, overlappingCandidate, ARCHIVE_START_MS, ARCHIVE_END_MS + 60_000);
    await assert.rejects(
      store.registerHistoryArchiveCandidate(overlappingCandidate),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_OVERLAP",
    );
    assert.equal(archiveDirectory(store), before);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("registration insert failure rolls back the directory transaction", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-store-"));
  const liveFile = path.join(root, "usage-index.sqlite");
  const sourceFile = path.join(root, "archive-source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = newStore(root, liveFile);
  try {
    await store.open();
    seedArchiveFacts(store.database, root);
    await makeV20ArchiveSource(root, sourceFile);
    await createCandidate(sourceFile, candidateFile, ARCHIVE_OUTSIDE_MS, ARCHIVE_OUTSIDE_MS + 60_000);
    store.database.exec(`
      CREATE TRIGGER fail_archive_registration
      BEFORE INSERT ON archive_segments
      BEGIN
        SELECT RAISE(ABORT, 'archive registration failed');
      END;
    `);
    try {
      await assert.rejects(store.registerHistoryArchiveCandidate(candidateFile), /archive registration failed/);
    } finally {
      store.database.exec("DROP TRIGGER fail_archive_registration");
    }
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 0);

    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.inserted, true);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
