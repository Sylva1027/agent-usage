import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryBackup,
  HISTORY_BACKUP_SCHEMA_VERSION,
  loadHistoryBackupContext,
  restoreHistoryBackup,
  verifyHistoryBackup,
} from "../src/history-backup.js";
import { getPricingCatalog, resetPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const DDL = `
  CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE source_files (
    path TEXT PRIMARY KEY, kind TEXT NOT NULL, home_id TEXT NOT NULL, home_label TEXT NOT NULL,
    home_path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, indexed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL, session_id TEXT NOT NULL, home_id TEXT NOT NULL, home_label TEXT NOT NULL,
    channel TEXT NOT NULL, project TEXT NOT NULL, model TEXT NOT NULL, hour_key TEXT NOT NULL,
    day_key TEXT NOT NULL, week_key TEXT NOT NULL, month_key TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '',
    repository_key TEXT NOT NULL DEFAULT 'unknown:cwd', repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
    repository_kind TEXT NOT NULL DEFAULT 'unknown', detail_mask INTEGER NOT NULL DEFAULT 0,
    reconciliation_gap INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_known INTEGER NOT NULL DEFAULT 0, request_input_tokens INTEGER NOT NULL DEFAULT 0,
    context_level TEXT NOT NULL DEFAULT 'unknown', service_tier TEXT NOT NULL DEFAULT 'unknown',
    price_version TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL, input INTEGER NOT NULL,
    cached INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE rate_limit_observations (
    source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    line_number INTEGER NOT NULL, role TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
    limit_id TEXT NOT NULL, limit_name TEXT, plan_type TEXT, window_minutes REAL NOT NULL,
    resets_at_ms INTEGER NOT NULL, used_percent REAL, PRIMARY KEY (source_path, line_number, role)
  ) STRICT;
  CREATE TABLE perf_samples (sample_key TEXT PRIMARY KEY, source_path TEXT NOT NULL REFERENCES source_files(path)) STRICT;
  CREATE TABLE perf_sample_sources (
    sample_key TEXT NOT NULL REFERENCES perf_samples(sample_key), source_path TEXT NOT NULL REFERENCES source_files(path),
    role TEXT NOT NULL, PRIMARY KEY (sample_key, source_path)
  ) STRICT;
  CREATE TABLE perf_rollout_threads (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path), home_id TEXT NOT NULL, thread_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE perf_codex_projections (path TEXT PRIMARY KEY, home_id TEXT NOT NULL) STRICT;
  CREATE TABLE workbuddy_generation_durations (message_id TEXT PRIMARY KEY, duration_ms INTEGER NOT NULL) STRICT;
  CREATE TABLE workbuddy_generation_duration_observations (
    home_id TEXT NOT NULL, message_id TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    PRIMARY KEY (home_id, message_id, duration_ms)
  ) STRICT;
  CREATE TABLE perf_request_timing_meta (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
  CREATE TABLE perf_request_timing_evidence (
    home_id TEXT NOT NULL, evidence_origin TEXT NOT NULL, response_id TEXT NOT NULL, variant_key TEXT NOT NULL,
    PRIMARY KEY (home_id, evidence_origin, response_id, variant_key)
  ) STRICT;
  CREATE TABLE perf_request_timing_threads (
    home_id TEXT NOT NULL, response_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    PRIMARY KEY (home_id, response_id, thread_id)
  ) STRICT;
  CREATE TABLE perf_request_timing_dirty_threads (
    home_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (home_id, thread_id)
  ) STRICT;
  -- Presence-only stand-in; the real schema is exercised by the UsageStore test below.
  CREATE TABLE history_replaced_facts (fixture TEXT NOT NULL) STRICT;
  -- Presence-only stand-in; the real schema is exercised by the UsageStore test below.
  CREATE TABLE archive_segments (
    segment_id TEXT PRIMARY KEY, database_path TEXT NOT NULL, database_sha256 TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, event_count INTEGER NOT NULL,
    registered_at_ms INTEGER NOT NULL, CHECK (end_ms > start_ms), CHECK (event_count >= 0)
  ) STRICT;
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const COST_AMOUNT_FIELDS = Object.freeze([
  "totalUsd",
  "inputUsd",
  "cachedInputUsd",
  "cacheWriteInputUsd",
  "outputUsd",
  "totalCny",
  "inputCny",
  "cachedInputCny",
  "cacheWriteInputCny",
  "outputCny",
]);
const COST_COUNT_FIELDS = Object.freeze([
  "pricedRecords",
  "unpricedRecords",
  "pricedTokens",
  "serviceTierUnknownRecords",
  "serviceTierUnknownTokens",
]);

function costEvidence(summary) {
  const cost = summary.costEstimate;
  return {
    amounts: Object.fromEntries(COST_AMOUNT_FIELDS.map((field) => [field, cost[field]])),
    currencies: cost.currencies,
    counts: Object.fromEntries(COST_COUNT_FIELDS.map((field) => [field, cost[field]])),
  };
}

function assertCostEvidence(actual, expected) {
  for (const field of COST_AMOUNT_FIELDS) {
    const left = actual.amounts[field];
    const right = expected.amounts[field];
    if (left === null || right === null) {
      assert.equal(left, right, field);
    } else {
      assert.ok(Math.abs(left - right) <= 1e-12, `${field}: ${left} != ${right}`);
    }
  }
  assert.deepEqual(actual.currencies, expected.currencies);
  assert.deepEqual(actual.counts, expected.counts);
}

function makeDatabase(root, name = "source.sqlite") {
  const file = path.join(root, name);
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    ${DDL}
    PRAGMA user_version = 21;
    INSERT INTO store_meta (key, value) VALUES ('fixture', 'schema21');
    INSERT INTO source_files VALUES ('rollout.jsonl', 'codex', 'home', 'Home', '/home', 1, 1, 'now');
    INSERT INTO events (
      id, source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (1, 'rollout.jsonl', 1, 'session', 'home', 'Home', 'main', 'project', 'model',
      'hour', 'day', 'week', 'month', 7, 4, 1, 2, 0);
  `);
  return { database, file };
}

function directorySnapshot(directory) {
  return readdirSync(directory)
    .sort()
    .filter((name) => !name.endsWith("-shm"))
    .map((name) => {
      const file = path.join(directory, name);
      const info = statSync(file);
      if (info.isDirectory()) return [name, "directory"];
      const bytes = readFileSync(file);
      return [name, bytes.byteLength, sha256(bytes)];
    });
}

function withTempRoot(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("backup includes committed WAL rows and verifies a complete package", async () => {
  const box = withTempRoot("history-backup-wal-");
  const source = makeDatabase(box.root);
  try {
    assert.equal(source.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(source.database.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint, 0);
    assert.ok(statSync(`${source.file}-wal`).size > 0);
    const destination = path.join(box.root, "package", "history.sqlite");
    const manifest = await createHistoryBackup(source.database, destination);
    assert.equal(manifest.schemaVersion, HISTORY_BACKUP_SCHEMA_VERSION);
    assert.deepEqual(
      { programVersion: manifest.programVersion, perfMethodVersion: manifest.perfMethodVersion },
      { programVersion: PACKAGE.version, perfMethodVersion: PERF_METHOD_VERSION },
    );
    assert.equal(manifest.database.bytes, statSync(destination).size);
    assert.equal(manifest.database.sha256, sha256(readFileSync(destination)));
    assert.equal(manifest.tables.events.rows, 1);
    for (const [table, evidence] of Object.entries(manifest.tables)) {
      const rows = source.database.prepare(`SELECT * FROM "${table}"`).all();
      assert.deepEqual(
        evidence,
        {
          rows: rows.length,
          sha256: sha256(rows.map((row) => `${JSON.stringify(row)}\n`).join("")),
        },
        table,
      );
    }
    assert.equal(manifest.quickCheck, "ok");
    assert.equal(manifest.foreignKeys, "ok");
    assert.deepEqual(readdirSync(path.dirname(destination)).sort(), ["history.manifest.json", "history.sqlite"]);
    assert.equal(statSync(destination).nlink, 1);
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.argv[1], { readOnly: true });
      process.stdout.write(JSON.stringify({
        total: database.prepare("SELECT SUM(total) AS total FROM events").get().total,
      }));
      database.close();
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, destination], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { total: 7 });
    const verified = await verifyHistoryBackup(destination);
    assert.equal(verified.ok, true);
    assert.equal(verified.manifest.database.sha256, manifest.database.sha256);
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("backup fingerprints preserve native JSON bytes with reused rows and the older SQLite API", async () => {
  const box = withTempRoot("history-backup-native-json-");
  const source = makeDatabase(box.root);
  const prepare = DatabaseSync.prototype.prepare;
  try {
    source.database.exec(
      'ALTER TABLE events ADD COLUMN real_value REAL; ALTER TABLE events ADD COLUMN "__proto__" TEXT;',
    );
    const original = source.database.prepare("SELECT * FROM events").get();
    const columns = Object.keys(original);
    const insert = source.database.prepare(
      `INSERT INTO events(${columns.map((name) => `"${name}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    );
    for (const [index, value] of [0, -0, 1e-7, 1e30, Number.MIN_VALUE, Infinity, null].entries()) {
      const row = { ...original, id: index + 2, real_value: value, ["__proto__"]: `中文\n"\\\u0000-${index}` };
      insert.run(...columns.map((name) => row[name]));
    }
    const expected = Object.fromEntries(
      source.database
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map(({ name }) => {
          const rows = source.database.prepare(`SELECT * FROM "${name}"`).all();
          return [name, { rows: rows.length, sha256: sha256(rows.map((row) => `${JSON.stringify(row)}\n`).join("")) }];
        }),
    );
    for (const fallback of [false, true]) {
      let fallbackReads = 0;
      DatabaseSync.prototype.prepare = function (sql, ...args) {
        const statement = prepare.call(this, sql, ...args);
        if (!fallback || !sql.startsWith('SELECT * FROM "')) return statement;
        fallbackReads++;
        return { iterate: statement.iterate.bind(statement) };
      };
      const file = path.join(box.root, `${fallback ? "fallback" : "native"}.sqlite`);
      const manifest = await createHistoryBackup(source.database, file);
      for (const [table, evidence] of Object.entries(manifest.tables))
        assert.deepEqual(evidence, expected[table], table);
      assert.equal((await verifyHistoryBackup(file)).ok, true);
      if (fallback) assert.ok(fallbackReads > 0, "the older API actually streams original named rows");
    }
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    source.database.close();
    box.cleanup();
  }
});

test("manifest records the pricing catalog and digest captured at backup start", async () => {
  const box = withTempRoot("history-backup-pricing-");
  const source = makeDatabase(box.root);
  try {
    const custom = getPricingCatalog();
    custom.checkedAt = "2026-10-22";
    custom.usdToCnyRate = 7.31;
    custom.models["a0-backup-fixture-model"] = {
      currency: "USD",
      source: "https://example.test/pricing",
      short: { input: 1.5, cachedInput: 0.15, cacheWrite: 1.75, output: 2.5 },
    };
    const effective = setPricingCatalog(custom);
    assert.ok(effective.version.startsWith("2026-10-22-"));

    const destination = path.join(box.root, "package", "history.sqlite");
    await createHistoryBackup(source.database, destination);
    const manifestFile = path.join(box.root, "package", "history.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    assert.deepEqual(manifest.pricing.catalog, effective);
    assert.equal(manifest.pricingVersion, effective.version);
    assert.equal(manifest.pricingCheckedAt, effective.checkedAt);
    assert.equal(manifest.pricing.sha256, sha256(JSON.stringify(effective)));
    await verifyHistoryBackup(destination);

    manifest.pricing.catalog.models["a0-backup-fixture-model"].short.input = 99;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(verifyHistoryBackup(destination), {
      code: "HISTORY_BACKUP_PRICING_MISMATCH",
    });
  } finally {
    resetPricingCatalog();
    source.database.close();
    box.cleanup();
  }
});

test("schema 21 backs up an empty archive directory and rejects registered segments", async () => {
  const box = withTempRoot("history-backup-schema21-");
  const store = new UsageStore({
    homeDir: box.root,
    env: {},
    importDirs: [],
    databaseFile: path.join(box.root, "usage.sqlite"),
  });
  try {
    await store.open();
    store.database.exec(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES ('schema21.jsonl', 'codex', 'home', 'Home', '/home', 1, 1, 'now');
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (
        'schema21.jsonl', 21, 'schema21-session', 'home', 'Home', 'main', 'project', 'model',
        'hour', 'day', 'week', 'month', 21, 17, 2, 2, 0
      );
    `);
    const sourceEvent = { ...store.database.prepare("SELECT * FROM events").get() };

    const destination = path.join(box.root, "package", "history.sqlite");
    const manifest = await createHistoryBackup(store.database, destination);
    assert.equal(manifest.schemaVersion, 21);
    assert.equal(manifest.tables.archive_segments.rows, 0);
    await verifyHistoryBackup(destination);

    const restored = path.join(box.root, "restored.sqlite");
    await restoreHistoryBackup(destination, restored);
    const restoredDatabase = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.deepEqual({ ...restoredDatabase.prepare("SELECT * FROM events").get() }, sourceEvent);
    } finally {
      restoredDatabase.close();
    }

    store.database
      .prepare("INSERT INTO archive_segments VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("sha256:segment", "segments/one.sqlite", "sha256:database", 10, 20, 0, 30);
    await assert.rejects(createHistoryBackup(store.database, path.join(box.root, "rejected", "history.sqlite")), {
      code: "HISTORY_BACKUP_ARCHIVES_UNSUPPORTED",
    });
  } finally {
    store.close();
    box.cleanup();
  }
});

test("schema 20 UsageStore backup restores a self-contained package with facts and tier evidence", async () => {
  const box = withTempRoot("history-backup-schema20-");
  const importDir = path.join(box.root, "import-a");
  const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
  const options = { homeDir: box.root, env: {}, importDirs: [importDir] };
  const store = new UsageStore({ ...options, databaseFile: path.join(box.root, "usage.sqlite") });
  try {
    const usageLine = (sessionId, total) =>
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: sessionId,
        model: "gpt-6-luna",
        usage: { total, input: total - 2, cached: 0, output: 2, reasoning: 0 },
      })}\n`;
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, usageLine("old-session", 10));
    await store.sync({ options });

    writeFileSync(usageFile, usageLine("new-session", 20));
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });

    store.database.exec("DROP TABLE archive_segments; PRAGMA user_version = 20;");
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 20);
    const fact = store.database
      .prepare("SELECT fact_table, occurrence_count, payload FROM history_replaced_facts")
      .get();
    assert.equal(fact.fact_table, "events");
    assert.equal(fact.occurrence_count, 1);
    const payload = JSON.parse(fact.payload);
    assert.equal(payload.session_id, "old-session");
    assert.equal(payload.total, 10);
    assert.deepEqual(
      store.database
        .prepare("SELECT session_id, total FROM events WHERE source_path = ?")
        .all(usageFile)
        .map((row) => ({ ...row })),
      [{ session_id: "new-session", total: 20 }],
    );

    const destination = path.join(box.root, "package", "history.sqlite");
    const serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: "restored-thread", turns: [{ time: 1, tier: "priority" }] }],
    });
    const manifest = await createHistoryBackup(store.database, destination, { serviceTierEvidence });
    assert.equal(manifest.schemaVersion, 20);
    assert.equal(Object.hasOwn(manifest.tables, "archive_segments"), false);
    assert.equal(manifest.tables.history_replaced_facts.rows, 1);
    const factDigest = manifest.tables.history_replaced_facts.sha256;
    await verifyHistoryBackup(destination);

    const restored = path.join(box.root, "restored.sqlite");
    const restoredPackage = await restoreHistoryBackup(destination, restored);
    assert.equal(restoredPackage.manifestFile, path.join(box.root, "restored.manifest.json"));
    assert.deepEqual(JSON.parse(readFileSync(restoredPackage.manifestFile, "utf8")), {
      ...manifest,
      database: { ...manifest.database, filename: "restored.sqlite" },
    });
    rmSync(path.join(box.root, "package"), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const script = `
      import { DatabaseSync } from "node:sqlite";
      import { loadHistoryBackupContext } from ${JSON.stringify(new URL("../src/history-backup.js", import.meta.url).href)};
      const context = await loadHistoryBackupContext(process.argv[1]);
      const database = new DatabaseSync(process.argv[1], { readOnly: true });
      const facts = database
        .prepare("SELECT payload FROM history_replaced_facts")
        .all()
        .map((row) => {
          const payload = JSON.parse(row.payload);
          return { session_id: payload.session_id, total: payload.total };
        });
      const events = database
        .prepare("SELECT session_id, total FROM events ORDER BY session_id")
        .all()
        .map((row) => ({ ...row }));
      database.close();
      process.stdout.write(JSON.stringify({
        facts,
        events,
        tier: context.serviceTierEvidence?.resolve("restored-thread", 1) ?? null,
        pricingVersion: context.pricingCatalog.version,
        manifestFile: context.manifestFile,
      }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, restored], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), {
      facts: [{ session_id: "old-session", total: 10 }],
      events: [{ session_id: "new-session", total: 20 }],
      tier: "priority",
      pricingVersion: manifest.pricingVersion,
      manifestFile: restoredPackage.manifestFile,
    });

    store.database.prepare("UPDATE history_replaced_facts SET occurrence_count = 2").run();
    const quantityManifest = await createHistoryBackup(
      store.database,
      path.join(box.root, "package-2", "history.sqlite"),
    );
    assert.notEqual(quantityManifest.tables.history_replaced_facts.sha256, factDigest);
  } finally {
    store.close();
    box.cleanup();
  }
});

test("schema 19 backup, verify, and restore preserve the source schema and data", async () => {
  const box = withTempRoot("history-backup-schema19-");
  const databaseFile = path.join(box.root, "usage.sqlite");
  const store = new UsageStore({ homeDir: box.root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    store.database.exec(`
      INSERT INTO source_files VALUES ('schema19.jsonl', 'codex', 'home', 'Home', '/home', 1, 1, 'now');
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (
        'schema19.jsonl', 1, 'schema19-session', 'home', 'Home', 'main', 'project', 'model',
        'hour', 'day', 'week', 'month', 19, 15, 2, 2, 0
      );
    `);
  } finally {
    store.close();
  }

  const downgrade = new DatabaseSync(databaseFile);
  try {
    // Dropping the two later tables produces the real prior shape without migrating the source.
    downgrade.exec("DROP TABLE archive_segments; DROP TABLE history_replaced_facts; PRAGMA user_version = 19;");
  } finally {
    downgrade.close();
  }

  const source = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const sourceBytes = readFileSync(databaseFile);
    assert.equal(source.prepare("PRAGMA user_version").get().user_version, 19);
    assert.equal(
      source.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'history_replaced_facts'").get().count,
      0,
    );
    assert.equal(
      source.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'archive_segments'").get().count,
      0,
    );

    const destination = path.join(box.root, "package", "history.sqlite");
    const manifest = await createHistoryBackup(source, destination);
    assert.equal(manifest.schemaVersion, 19);
    assert.equal(Object.hasOwn(manifest.tables, "history_replaced_facts"), false);
    await verifyHistoryBackup(destination);

    const restored = path.join(box.root, "restored.sqlite");
    await restoreHistoryBackup(destination, restored);
    const restoredDatabase = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.equal(restoredDatabase.prepare("PRAGMA user_version").get().user_version, 19);
      assert.equal(restoredDatabase.prepare("SELECT SUM(total) AS total FROM events").get().total, 19);
    } finally {
      restoredDatabase.close();
    }
    assert.equal(JSON.parse(readFileSync(path.join(box.root, "restored.manifest.json"), "utf8")).schemaVersion, 19);
    assert.deepEqual(readFileSync(databaseFile), sourceBytes);
  } finally {
    source.close();
    box.cleanup();
  }
});

test("backup manifest pricing restores the same custom-priced summary", async () => {
  const box = withTempRoot("history-backup-pricing-summary-");
  const importDir = path.join(box.root, "import-a");
  const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
  const options = { homeDir: box.root, env: {}, importDirs: [importDir] };
  const store = new UsageStore({ ...options, databaseFile: path.join(box.root, "usage.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/import",
        cwd: "/work/import",
        session_id: "priced-session",
        model: "gpt-6-luna",
        usage: { total: 20, input: 18, cached: 0, output: 2, reasoning: 0 },
      })}\n`,
    );
    await store.sync({ options });

    const defaultRates = getPricingCatalog().models["gpt-6-luna"].short;
    const defaultEvidence = costEvidence(store.summarize({ preset: "all" }));
    const custom = getPricingCatalog();
    custom.checkedAt = "2026-10-22";
    custom.usdToCnyRate = 7.31;
    custom.models["gpt-6-luna"].short = {
      input: defaultRates.input + 1,
      cachedInput: defaultRates.cachedInput + 1,
      cacheWrite: defaultRates.cacheWrite + 1,
      output: defaultRates.output + 1,
    };
    const effective = setPricingCatalog(custom);
    assert.notDeepEqual(effective.models["gpt-6-luna"].short, defaultRates);

    const originalEvidence = costEvidence(store.summarize({ preset: "all" }));
    assert.ok(originalEvidence.counts.pricedRecords > 0);
    assert.notEqual(originalEvidence.amounts.totalUsd, defaultEvidence.amounts.totalUsd);

    const destination = path.join(box.root, "package", "history.sqlite");
    const manifest = await createHistoryBackup(store.database, destination);
    assert.deepEqual(manifest.pricing.catalog, effective);

    const restored = path.join(box.root, "restored.sqlite");
    await restoreHistoryBackup(destination, restored);
    const manifestFile = path.join(box.root, "package", "history.manifest.json");
    const amountFields = JSON.stringify(COST_AMOUNT_FIELDS);
    const countFields = JSON.stringify(COST_COUNT_FIELDS);
    const script = `
      import { readFileSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { UsageStore } from ${JSON.stringify(new URL("../src/usage-store.js", import.meta.url).href)};
      import { setPricingCatalog } from ${JSON.stringify(new URL("../src/pricing.js", import.meta.url).href)};
      import { sourceGroup } from ${JSON.stringify(new URL("../public/timeline-utils.js", import.meta.url).href)};
      const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
      setPricingCatalog(manifest.pricing.catalog);
      const file = process.argv[2];
      const database = new DatabaseSync(file, { readOnly: true });
      database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
      const store = new UsageStore({ databaseFile: file });
      store.database = database;
      store.homes = database
        .prepare("SELECT kind, home_id, home_label, home_path FROM source_files")
        .all()
        .map((row) => ({ kind: row.kind, id: row.home_id, label: row.home_label, path: row.home_path }));
      store.observedDataVersion = store.readDataVersion();
      store.generatedAt = store.readMeta("generated_at");
      const cost = store.summarize({ preset: "all" }).costEstimate;
      const evidence = {
        amounts: Object.fromEntries(${amountFields}.map((field) => [field, cost[field]])),
        currencies: cost.currencies,
        counts: Object.fromEntries(${countFields}.map((field) => [field, cost[field]])),
      };
      store.close();
      process.stdout.write(JSON.stringify(evidence));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, manifestFile, restored], {
      encoding: "utf8",
    });
    assertCostEvidence(JSON.parse(output), originalEvidence);
  } finally {
    resetPricingCatalog();
    store.close();
    box.cleanup();
  }
});

test("backup captures resolver evidence while preserving an explicit uncaptured package", async () => {
  const box = withTempRoot("history-backup-tier-gap-");
  const codexHome = path.join(box.root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "24");
  const threadId = "tier-gap-thread";
  const eventTime = Date.parse("2026-09-24T10:01:05Z");
  const store = new UsageStore({ homeDir: box.root, databaseFile: path.join(box.root, "usage.sqlite") });
  try {
    mkdirSync(sessionDir, { recursive: true });
    const log = new DatabaseSync(path.join(codexHome, "logs_2.sqlite"));
    try {
      log.exec(
        "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
      );
      log
        .prepare(
          "INSERT INTO logs (ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, 0, ?, 'codex_core::session::handlers', ?)",
        )
        .run(
          Date.parse("2026-09-24T10:01:00Z") / 1000,
          threadId,
          `session_loop{thread_id=${threadId}}: Submission sub=Submission { id: "tier-gap", op: TurnInput { request: { input: UserInput { content: [] }, service_tier: Some(Some("priority")), collaboration_mode: None } } }`,
        );
    } finally {
      log.close();
    }

    const usage = {
      total_tokens: 100_000,
      input_tokens: 100_000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
    };
    const rows = [
      {
        timestamp: "2026-09-24T10:00:00Z",
        type: "session_meta",
        payload: { id: threadId, source: "cli", originator: "codex-tui", cwd: box.root },
      },
      { timestamp: "2026-09-24T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        timestamp: "2026-09-24T10:01:05Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      },
    ];
    writeFileSync(
      path.join(sessionDir, "rollout-tier-gap.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    await store.sync({ options: { homeDir: box.root } });
    assert.equal(store.database.prepare("SELECT service_tier FROM events").get().service_tier, "unknown");
    assert.equal(store.serviceTierEvidence.resolve(threadId, eventTime, "unknown"), "priority");
    const originalEvidence = costEvidence(store.summarize({ preset: "all" }));
    assert.equal(originalEvidence.counts.serviceTierUnknownRecords, 0);
    assert.equal(originalEvidence.counts.serviceTierUnknownTokens, 0);
    assert.ok(originalEvidence.amounts.totalUsd > 0);

    const gapDestination = path.join(box.root, "package-gap", "history.sqlite");
    const gapManifest = await createHistoryBackup(store.database, gapDestination);
    assert.equal(gapManifest.serviceTierEvidence, null);

    const capturedDestination = path.join(box.root, "package-captured", "history.sqlite");
    const capturedManifest = await createHistoryBackup(store.database, capturedDestination, {
      serviceTierEvidence: store.serviceTierEvidence,
    });
    const captured = capturedManifest.serviceTierEvidence;
    assert.equal(captured.sha256, sha256(JSON.stringify(captured.snapshot)));
    assert.deepEqual(captured.snapshot.threads, [
      { threadId, turns: [{ time: Date.parse("2026-09-24T10:01:00Z"), tier: "priority" }] },
    ]);
    const capturedContext = await loadHistoryBackupContext(capturedDestination);
    assert.deepEqual(capturedContext.pricingCatalog, capturedManifest.pricing.catalog);
    assert.equal(capturedContext.serviceTierEvidence.resolve(threadId, eventTime), "priority");
    assert.equal((await loadHistoryBackupContext(gapDestination)).serviceTierEvidence, null);

    const restoredGap = path.join(box.root, "restored-gap.sqlite");
    await restoreHistoryBackup(gapDestination, restoredGap);
    const restoredCaptured = path.join(box.root, "restored-captured.sqlite");
    await restoreHistoryBackup(capturedDestination, restoredCaptured);
    const gapManifestFile = path.join(box.root, "package-gap", "history.manifest.json");
    const capturedManifestFile = path.join(box.root, "package-captured", "history.manifest.json");

    const originalManifestText = readFileSync(capturedManifestFile, "utf8");
    const badDigest = JSON.parse(originalManifestText);
    badDigest.serviceTierEvidence.snapshot.threads[0].turns[0].tier = "default";
    writeFileSync(capturedManifestFile, `${JSON.stringify(badDigest)}\n`);
    await assert.rejects(loadHistoryBackupContext(capturedDestination), {
      code: "HISTORY_BACKUP_SERVICE_TIER_EVIDENCE_MISMATCH",
    });

    const badSnapshot = structuredClone(capturedManifest);
    badSnapshot.serviceTierEvidence.snapshot.threads[0].turns[0].extra = true;
    badSnapshot.serviceTierEvidence.sha256 = sha256(JSON.stringify(badSnapshot.serviceTierEvidence.snapshot));
    writeFileSync(capturedManifestFile, `${JSON.stringify(badSnapshot)}\n`);
    await assert.rejects(loadHistoryBackupContext(capturedDestination), {
      code: "HISTORY_BACKUP_BAD_MANIFEST",
    });
    writeFileSync(capturedManifestFile, originalManifestText);
    await loadHistoryBackupContext(capturedDestination);

    store.close();
    rmSync(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const amountFields = JSON.stringify(COST_AMOUNT_FIELDS);
    const countFields = JSON.stringify(COST_COUNT_FIELDS);
    const script = `
      import { DatabaseSync } from "node:sqlite";
      import { loadHistoryBackupContext } from ${JSON.stringify(new URL("../src/history-backup.js", import.meta.url).href)};
      import { UsageStore } from ${JSON.stringify(new URL("../src/usage-store.js", import.meta.url).href)};
      import { setPricingCatalog } from ${JSON.stringify(new URL("../src/pricing.js", import.meta.url).href)};
      import { sourceGroup } from ${JSON.stringify(new URL("../public/timeline-utils.js", import.meta.url).href)};
      const summarize = async (manifestFile, file, useSnapshot) => {
        const context = await loadHistoryBackupContext(file, manifestFile);
        setPricingCatalog(context.pricingCatalog);
        const database = new DatabaseSync(file, { readOnly: true });
        database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
        const store = new UsageStore({ databaseFile: file });
        store.database = database;
        store.homes = database
          .prepare("SELECT kind, home_id, home_label, home_path FROM source_files")
          .all()
          .map((row) => ({ kind: row.kind, id: row.home_id, label: row.home_label, path: row.home_path }));
        store.observedDataVersion = store.readDataVersion();
        store.generatedAt = store.readMeta("generated_at");
        if (useSnapshot) {
          if (context.serviceTierEvidence === null) throw new Error("expected captured tier evidence");
          store.serviceTierEvidence = context.serviceTierEvidence;
        }
        const cost = store.summarize({ preset: "all" }).costEstimate;
        const result = {
          evidence: {
            amounts: Object.fromEntries(${amountFields}.map((field) => [field, cost[field]])),
            currencies: cost.currencies,
            counts: Object.fromEntries(${countFields}.map((field) => [field, cost[field]])),
          },
          recordedTiers: database.prepare("SELECT service_tier FROM events ORDER BY id").all().map((row) => row.service_tier),
        };
        store.close();
        return result;
      };
      process.stdout.write(JSON.stringify({
        captured: await summarize(process.argv[1], process.argv[2], true),
        gap: await summarize(process.argv[3], process.argv[4], false),
      }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, capturedManifestFile, restoredCaptured, gapManifestFile, restoredGap],
      { encoding: "utf8" },
    );
    const restoredResult = JSON.parse(output);
    assert.deepEqual(restoredResult.captured.recordedTiers, ["unknown"]);
    assertCostEvidence(restoredResult.captured.evidence, originalEvidence);
    assert.deepEqual(restoredResult.gap.recordedTiers, ["unknown"]);
    assert.equal(restoredResult.gap.evidence.counts.serviceTierUnknownRecords, 1);
    assert.equal(restoredResult.gap.evidence.counts.serviceTierUnknownTokens, 100_000);
    assert.ok(Math.abs(restoredResult.gap.evidence.amounts.totalUsd - originalEvidence.amounts.totalUsd) > 1e-12);
  } finally {
    store.close();
    box.cleanup();
  }
});

test("restore works in a new process and produces the same committed query", async () => {
  const box = withTempRoot("history-backup-restore-");
  const source = makeDatabase(box.root);
  try {
    const destination = path.join(box.root, "package", "history.sqlite");
    await createHistoryBackup(source.database, destination);
    const restored = path.join(box.root, "restored", "history.sqlite");
    await restoreHistoryBackup(destination, restored);
    assert.equal(sha256(readFileSync(restored)), sha256(readFileSync(destination)));
    assert.equal(statSync(restored).nlink, 1);
    assert.equal(
      readdirSync(box.root).some((name) => name.includes(".history-backup-tmp-")),
      false,
    );
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.argv[1], { readOnly: true });
      const result = {
        total: database.prepare("SELECT SUM(total) AS total FROM events").get().total,
        files: database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n,
      };
      database.close();
      process.stdout.write(JSON.stringify(result));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, restored], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { total: 7, files: 1 });
    await assert.rejects(restoreHistoryBackup(destination, restored), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("backup failure leaves no completed artifacts and does not change the source", async () => {
  const box = withTempRoot("history-backup-fail-");
  const source = makeDatabase(box.root);
  try {
    source.database.exec("DROP TABLE perf_request_timing_dirty_threads");
    const before = directorySnapshot(box.root);
    const destination = path.join(box.root, "package", "history.sqlite");
    await assert.rejects(createHistoryBackup(source.database, destination), {
      code: "HISTORY_BACKUP_MISSING_TABLE",
    });
    const after = directorySnapshot(box.root).filter(([name]) => name !== "package");
    assert.deepEqual(after, before);
    assert.deepEqual(readdirSync(path.dirname(destination)), []);
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("exclusive publication preserves foreign targets and cleans only its own artifacts", async () => {
  const box = withTempRoot("history-backup-exclusive-");
  const source = makeDatabase(box.root);
  try {
    const target = path.join(box.root, "target.sqlite");
    writeFileSync(target, "foreign-database");
    await assert.rejects(createHistoryBackup(source.database, target), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
    assert.equal(readFileSync(target, "utf8"), "foreign-database");

    const manifestTarget = path.join(box.root, "manifest-target.sqlite");
    const manifestFile = path.join(box.root, "manifest-target.manifest.json");
    writeFileSync(manifestFile, "foreign-manifest");
    await assert.rejects(createHistoryBackup(source.database, manifestTarget), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
    assert.equal(readFileSync(manifestFile, "utf8"), "foreign-manifest");
    assert.equal(readdirSync(box.root).includes(path.basename(manifestTarget)), false);

    const leftovers = readdirSync(box.root).filter(
      (name) => name.includes(".history-backup-tmp-") || name.includes(".manifest-tmp-"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("restore refuses an existing destination without changing it", async () => {
  const box = withTempRoot("history-backup-restore-exclusive-");
  const source = makeDatabase(box.root);
  try {
    const backupFile = path.join(box.root, "package", "history.sqlite");
    await createHistoryBackup(source.database, backupFile);
    const restored = path.join(box.root, "restored.sqlite");
    writeFileSync(restored, "foreign-restore");
    await assert.rejects(restoreHistoryBackup(backupFile, restored), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
    assert.equal(readFileSync(restored, "utf8"), "foreign-restore");

    const blockedByManifest = path.join(box.root, "manifest-blocked.sqlite");
    const foreignManifest = path.join(box.root, "manifest-blocked.manifest.json");
    writeFileSync(foreignManifest, "foreign-manifest");
    await assert.rejects(restoreHistoryBackup(backupFile, blockedByManifest), {
      code: "HISTORY_BACKUP_DESTINATION_EXISTS",
    });
    assert.equal(readFileSync(foreignManifest, "utf8"), "foreign-manifest");
    assert.equal(readdirSync(box.root).includes(path.basename(blockedByManifest)), false);
    assert.deepEqual(
      readdirSync(box.root).filter((name) => name.includes(".history-backup-tmp-") || name.includes(".manifest-tmp-")),
      [],
    );
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("verification rejects a bad digest, a database byte change, a missing evidence table, and an unknown schema", async () => {
  const box = withTempRoot("history-backup-verify-");
  const source = makeDatabase(box.root);
  try {
    const destination = path.join(box.root, "package", "history.sqlite");
    await createHistoryBackup(source.database, destination);
    const manifestFile = path.join(box.root, "package", "history.manifest.json");
    const originalManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const originalDatabase = readFileSync(destination);

    const badDigest = structuredClone(originalManifest);
    badDigest.database.sha256 = "0".repeat(64);
    writeFileSync(manifestFile, `${JSON.stringify(badDigest)}\n`);
    await assert.rejects(verifyHistoryBackup(destination), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });

    writeFileSync(manifestFile, `${JSON.stringify(originalManifest)}\n`);
    const sentinel = Buffer.from("schema21");
    const offset = originalDatabase.indexOf(sentinel);
    assert.ok(offset >= 0);
    assert.equal(originalDatabase.indexOf(sentinel, offset + 1), -1);
    const tampered = Buffer.from(originalDatabase);
    tampered[offset] = "X".charCodeAt(0);
    writeFileSync(destination, tampered);
    const readable = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(readable.prepare("SELECT value FROM store_meta WHERE key = 'fixture'").get().value, "Xchema21");
    } finally {
      readable.close();
    }
    await assert.rejects(verifyHistoryBackup(destination), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    const rehashedManifest = structuredClone(originalManifest);
    rehashedManifest.database.sha256 = sha256(tampered);
    writeFileSync(manifestFile, `${JSON.stringify(rehashedManifest)}\n`);
    await assert.rejects(verifyHistoryBackup(destination), { code: "HISTORY_BACKUP_TABLE_MISMATCH" });
    writeFileSync(manifestFile, `${JSON.stringify(originalManifest)}\n`);
    writeFileSync(destination, originalDatabase);

    const missing = new DatabaseSync(destination);
    try {
      missing.exec("DROP TABLE archive_segments");
    } finally {
      missing.close();
    }
    const missingManifest = structuredClone(originalManifest);
    const missingBytes = readFileSync(destination);
    missingManifest.database.bytes = missingBytes.byteLength;
    missingManifest.database.sha256 = sha256(missingBytes);
    writeFileSync(manifestFile, `${JSON.stringify(missingManifest)}\n`);
    await assert.rejects(verifyHistoryBackup(destination), { code: "HISTORY_BACKUP_MISSING_TABLE" });

    const unknown = makeDatabase(box.root, "unknown.sqlite");
    unknown.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`);
    await assert.rejects(
      createHistoryBackup(unknown.database, path.join(box.root, "unknown-package.sqlite")),
      (error) => error.code === "HISTORY_BACKUP_UNSUPPORTED_SCHEMA",
    );
    unknown.database.close();
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("verified byte identity reuses table evidence while rechecking files, manifests and WAL", async () => {
  const box = withTempRoot("history-backup-byte-proof-");
  const source = makeDatabase(box.root);
  const prepare = DatabaseSync.prototype.prepare;
  let writer;
  try {
    const file = path.join(box.root, "proof.sqlite");
    const manifest = await createHistoryBackup(source.database, file);
    const manifestFile = path.join(box.root, "proof.manifest.json");
    const original = readFileSync(file);
    let scans = 0;
    let beforeSchema;
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (sql === "PRAGMA user_version" && beforeSchema) {
        const mutate = beforeSchema;
        beforeSchema = null;
        mutate();
      }
      if (/^SELECT \* FROM "/.test(sql)) scans += 1;
      return prepare.call(this, sql, ...args);
    };
    const verified = await verifyHistoryBackup(file);
    assert.equal(scans, Object.keys(manifest.tables).length);
    assert.deepEqual(await verifyHistoryBackup(file), verified);
    assert.equal(scans, Object.keys(manifest.tables).length, "identical freshly hashed bytes need one table proof");

    beforeSchema = () => {
      const external = new DatabaseSync(file);
      try {
        external.exec("UPDATE store_meta SET value = 'changed-after-hash' WHERE key = 'fixture'");
      } finally {
        external.close();
      }
    };
    await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    writeFileSync(file, original);

    const tampered = Buffer.from(original);
    tampered[tampered.indexOf(Buffer.from("schema21"))] = "X".charCodeAt(0);
    writeFileSync(file, tampered);
    await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    writeFileSync(file, original);
    const badManifest = structuredClone(manifest);
    badManifest.tables.events.sha256 = "f".repeat(64);
    writeFileSync(manifestFile, JSON.stringify(badManifest));
    await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_TABLE_MISMATCH" });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.deepEqual(await verifyHistoryBackup(file), verified);

    const changed = new DatabaseSync(file);
    const racedManifest = structuredClone(manifest);
    try {
      changed.exec("UPDATE store_meta SET value = 'raced-first-proof' WHERE key = 'fixture'");
      racedManifest.tables.store_meta.sha256 = sha256(
        changed
          .prepare('SELECT * FROM "store_meta"')
          .all()
          .map((row) => `${JSON.stringify(row)}\n`)
          .join(""),
      );
    } finally {
      changed.close();
    }
    writeFileSync(file, original);
    writeFileSync(manifestFile, JSON.stringify(racedManifest));
    beforeSchema = () => {
      const external = new DatabaseSync(file);
      try {
        external.exec("UPDATE store_meta SET value = 'raced-first-proof' WHERE key = 'fixture'");
      } finally {
        external.close();
      }
    };
    await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    writeFileSync(file, original);
    writeFileSync(manifestFile, JSON.stringify(manifest));

    writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)");
    const walManifest = structuredClone(manifest);
    walManifest.database.sha256 = sha256(readFileSync(file));
    writeFileSync(manifestFile, JSON.stringify(walManifest));
    await verifyHistoryBackup(file);
    writer.exec("UPDATE store_meta SET value = 'changed-in-wal' WHERE key = 'fixture'");
    assert.equal(sha256(readFileSync(file)), walManifest.database.sha256, "committed WAL leaves main bytes unchanged");
    await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_TABLE_MISMATCH" });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    writer?.close();
    source.database.close();
    box.cleanup();
  }
});
