import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hermesHomeLooksUsable, hermesSourceStat, streamHermesDbEvents } from "../src/hermes-usage.js";
import {
  buildUsageIndex,
  buildUsageReport,
  buildUsageFingerprint,
  classifyImportDirectory,
  discoverUsageSources,
  discoverHermesHomes,
  summarizeUsage,
  summarizeUsageIndex,
} from "../src/usage-core.js";
import { scanImportSources } from "../src/source-imports.js";
import { UsageStore } from "../src/usage-store.js";
import {
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  loadHistoryArchiveImport,
} from "../src/history-archive.js";
import { createUsageRollups } from "../src/usage-rollups.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createHistoryBackup } from "../src/history-backup.js";
import { compactRegisteredHistory } from "../src/history-archive-compaction.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const file = path.join(root, "state.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, git_repo_root TEXT,
    started_at REAL, last_activity_at REAL, input_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT,
    billing_base_url TEXT, billing_mode TEXT, task TEXT, input_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, first_seen REAL, last_seen REAL,
    PRIMARY KEY(session_id,model,billing_provider,billing_base_url,billing_mode,task));
    INSERT INTO sessions VALUES ('s','subagent','/repo',NULL,100,200,999,0,0,1,0),
      ('fallback','cli',NULL,NULL,100,200,100,0,0,40,0);
    INSERT INTO session_model_usage VALUES ('s','glm-5.1','provider','secret-endpoint','api','voice_chat',
      100,20,10,40,5,100,200), ('s','glm-5.1','provider','secret-endpoint','api','title_generation',
      10,0,0,5,0,100,200);`);
  return { root, file, db, source: { id: "home", label: "Hermes", path: root } };
}

async function read(input) {
  const events = [];
  await streamHermesDbEvents(input.file, input.source, (event) => events.push(event), {
    maxBytes: 1,
    repositoryResolver: async (cwd) => ({ key: cwd || "unknown:cwd", path: cwd || "Unknown cwd", kind: "directory" }),
  });
  return events;
}

test("Hermes fingerprint reads ledger changes even when every filesystem observation collides", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root };
  const actualStat = fs.stat;
  const fixed = await actualStat(input.file);
  const mocked = t.mock.method(fs, "stat", (file, ...args) =>
    file === input.file ? Promise.resolve(fixed) : actualStat(file, ...args),
  );
  syncBuiltinESMExports();
  try {
    const first = await hermesSourceStat(input.file);
    const before = await buildUsageFingerprint(options);
    input.db.exec("UPDATE session_model_usage SET input_tokens=120 WHERE task='voice_chat'");
    const second = await hermesSourceStat(input.file);
    assert.equal(first.sqliteObservation, second.sqliteObservation);
    assert.notEqual(first.contentDigest, second.contentDigest);
    assert.notEqual(before.fingerprint, (await buildUsageFingerprint(options)).fingerprint);
    assert.equal(second.contentDigest, (await hermesSourceStat(input.file)).contentDigest);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    input.db.close();
  }
});

test("Hermes scan isolates denied profiles and confirmed sources retain prior facts", async (t) => {
  const input = fixture(t);
  const root = path.join(input.root, "hermes");
  const bad = path.join(root, "profiles", "denied");
  const good = path.join(root, "profiles", "healthy");
  input.db.close();
  for (const directory of [root, bad, good]) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(input.file, path.join(directory, "state.db"));
  }
  const options = { homeDir: input.root, env: { HERMES_HOME: root }, platform: "win32" };
  const confirmedSources = await discoverHermesHomes(options);
  assert.equal(confirmedSources.length, 3);
  const storeOptions = { ...options, confirmedSources, databaseFile: path.join(input.root, "index.sqlite") };
  const store = new UsageStore(storeOptions);
  const actualStat = fs.stat;
  let mocked;
  try {
    await store.sync();
    assert.equal(store.summarize({ preset: "all" }).totals.total, 975);
    mocked = t.mock.method(fs, "stat", async (file, ...args) => {
      if (file === path.join(bad, "state.db"))
        throw Object.assign(new Error("Access denied"), { code: "EACCES", path: file });
      return actualStat(file, ...args);
    });
    syncBuiltinESMExports();
    const scan = await scanImportSources(options);
    assert.deepEqual(
      new Set(scan.candidates.filter((home) => home.kind === "hermes").map((home) => home.path)),
      new Set([root, good]),
    );
    assert.ok(scan.errors.some((error) => error.code === "EACCES" && error.path === path.join(bad, "state.db")));
    const report = await buildUsageReport(options);
    assert.equal(
      report.events.reduce((sum, event) => sum + event.total.total, 0),
      650,
    );
    assert.ok(report.warnings.some((warning) => warning.includes("Access denied")));
    await store.sync();
    assert.equal(store.summarize({ preset: "all" }).totals.total, 975);
    assert.ok(store.warnings.some((warning) => warning.includes("Access denied")));
    mocked.mock.restore();
    syncBuiltinESMExports();
    await store.sync();
    assert.equal(store.summarize({ preset: "all" }).totals.total, 975);
    assert.ok(!store.warnings.some((warning) => warning.includes("Access denied")));
    await fs.writeFile(path.join(bad, "state.db"), "not a SQLite database");
    const corrupt = await scanImportSources(options);
    assert.equal(corrupt.candidates.filter((home) => home.kind === "hermes").length, 2);
    assert.ok(corrupt.errors.some((error) => error.path === bad));
    await store.sync();
    assert.equal(store.summarize({ preset: "all" }).totals.total, 975);
    assert.ok(store.warnings.some((warning) => warning.includes(bad)));
  } finally {
    mocked?.mock.restore();
    syncBuiltinESMExports();
    store.close();
  }
});

test("Hermes ledger diagnostics reach report, compact index and store without adding residual usage", async (t) => {
  const input = fixture(t);
  input.db.exec(`DELETE FROM session_model_usage WHERE task='title_generation';
    DELETE FROM sessions WHERE id='fallback';
    ALTER TABLE sessions ADD COLUMN api_call_count INTEGER;
    ALTER TABLE session_model_usage ADD COLUMN api_call_count INTEGER;
    UPDATE sessions SET input_tokens=900,cache_read_tokens=20,cache_write_tokens=10,output_tokens=70,reasoning_tokens=5,api_call_count=9;
    UPDATE session_model_usage SET api_call_count=2;`);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    const report = await buildUsageReport(options);
    const index = await buildUsageIndex(options);
    await store.sync();
    assert.equal(
      report.events.reduce((sum, event) => sum + event.total.total, 0),
      170,
    );
    assert.equal(
      index.events.reduce((sum, event) => sum + event.total, 0),
      170,
    );
    assert.equal(store.summarize({ preset: "all" }).totals.total, 170);
    for (const warnings of [report.warnings, index.warnings, store.warnings]) {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /input_tokens=800.*output_tokens=30.*api_call_count=7/);
      assert.ok(!warnings[0].includes("secret-endpoint"));
    }
    const events = [];
    const warnings = [];
    await streamHermesDbEvents(input.file, input.source, (event) => events.push(event), {
      maxBytes: 1,
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal(events.length, 1);
    assert.deepEqual(warnings, report.warnings);
    input.db.exec("UPDATE sessions SET input_tokens=100,output_tokens=40,api_call_count=2");
    await store.sync();
    assert.deepEqual(store.warnings, []);
  } finally {
    store.close();
    input.db.close();
  }
});

test("Hermes snapshots preserve model identity and fall back only for sessions without model rows", async (t) => {
  const input = fixture(t);
  try {
    assert.equal(await hermesHomeLooksUsable(input.root), true);
    const events = await read(input);
    assert.equal(events.length, 3);
    const main = events.find((event) => event.usage.total === 170);
    assert.deepEqual(main.usage, { input: 130, cached: 20, output: 40, reasoning: 5, total: 170 });
    assert.equal(main.detailMask, 15);
    assert.equal(main.channel, "Hermes Subagent");
    assert.equal(events.find((event) => event.sessionId === "fallback").model, "Unknown model");
    assert.equal(JSON.stringify(events).includes("secret-endpoint"), false);
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120,last_seen=300 WHERE task='voice_chat'").run();
    const revised = (await read(input)).find((event) => event.usage.total === 190);
    assert.equal(revised.sourceEventId, main.sourceEventId);
    assert.notEqual(revised.timestampMs, main.timestampMs);
  } finally {
    input.db.close();
  }
});

test("Hermes rejects an invalid snapshot before emitting events", async (t) => {
  const input = fixture(t);
  try {
    input.db.prepare("UPDATE session_model_usage SET input_tokens=-1 WHERE task='title_generation'").run();
    const events = [];
    await assert.rejects(
      streamHermesDbEvents(input.file, input.source, (event) => events.push(event)),
      /Invalid Hermes token count/,
    );
    assert.deepEqual(events, []);
  } finally {
    input.db.close();
  }
});

test("Hermes reports a live source change before the snapshot is committed", async (t) => {
  const input = fixture(t);
  try {
    let changed = false;
    await assert.rejects(
      streamHermesDbEvents(input.file, input.source, () => {
        if (!changed) {
          changed = true;
          input.db.prepare("UPDATE session_model_usage SET input_tokens=121 WHERE task='voice_chat'").run();
        }
      }),
      { code: "LIVE_SOURCE_CHANGED", retryable: true },
    );
  } finally {
    input.db.close();
  }
});

test("Hermes sync observes WAL-only revisions and checkpoints", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    input.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 325);
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120 WHERE task='voice_chat'").run();
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 345);
    input.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    input.db.prepare("UPDATE session_model_usage SET input_tokens=110 WHERE task='voice_chat'").run();
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 335);
  } finally {
    store.close();
    input.db.close();
  }
});

test("Hermes discovers configured roots and profiles without duplicating junction aliases", async (t) => {
  const input = fixture(t);
  try {
    input.db.close();
    const root = path.join(input.root, "local", "hermes");
    const profile = path.join(root, "profiles", "agent");
    mkdirSync(profile, { recursive: true });
    copyFileSync(input.file, path.join(root, "state.db"));
    copyFileSync(input.file, path.join(profile, "state.db"));
    const alias = path.join(input.root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const env = {
      LOCALAPPDATA: path.join(input.root, "local"),
      HERMES_HOME: "%LOCALAPPDATA%/hermes",
      CODEX_USAGE_HERMES_HOMES: alias,
    };
    const homes = await discoverHermesHomes({ homeDir: input.root, env, platform: "win32" });
    assert.equal(homes.length, 2);
    assert.ok(homes.some((home) => home.path === profile));
    const disabled = await discoverHermesHomes({
      homeDir: input.root,
      env: { ...env, CODEX_USAGE_HERMES: "0" },
      platform: "win32",
    });
    assert.deepEqual(
      disabled.map((home) => home.path),
      [alias],
    );
  } finally {
    if (input.db.isOpen) input.db.close();
  }
});

test("Hermes discovers Unix homes, expanded environment paths and profiles", async (t) => {
  const input = fixture(t);
  try {
    input.db.close();
    const main = path.join(input.root, ".hermes");
    const profile = path.join(main, "profiles", "worker");
    const configured = path.join(input.root, "named");
    const linkedTarget = path.join(input.root, "linked-target");
    const linkedProfile = path.join(main, "profiles", "linked");
    for (const directory of [main, profile, configured, linkedTarget]) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(input.file, path.join(directory, "state.db"));
    }
    symlinkSync(linkedTarget, linkedProfile, process.platform === "win32" ? "junction" : "dir");
    const alias = path.join(input.root, "alias");
    const secondAlias = path.join(input.root, "alias-two");
    symlinkSync(main, alias, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(main, secondAlias, process.platform === "win32" ? "junction" : "dir");
    const homes = await discoverHermesHomes({
      homeDir: input.root,
      platform: "linux",
      env: { HERMES_PARENT: input.root, HERMES_HOME: "$" + "{HERMES_PARENT}/named", CODEX_USAGE_HERMES_HOMES: alias },
    });
    assert.deepEqual(new Set(homes.map((home) => home.path)), new Set([main, profile, linkedProfile, configured]));
    const sources = await discoverUsageSources({
      homeDir: input.root,
      platform: "linux",
      env: { HERMES_PARENT: input.root, HERMES_HOME: "$" + "{HERMES_PARENT}/named" },
      importDirs: [alias],
    });
    assert.equal(sources.filter((home) => home.kind === "hermes").length, 4);
    const report = await buildUsageReport({ homes: sources });
    assert.equal(
      report.events.reduce((sum, event) => sum + event.total.total, 0),
      1300,
    );
    const configuredAliases = await discoverUsageSources({
      homeDir: input.root,
      env: {},
      onlyConfiguredSources: true,
      importDirs: [alias, secondAlias],
    });
    assert.equal(configuredAliases.filter((home) => home.kind === "hermes").length, 1);
  } finally {
    if (input.db.isOpen) input.db.close();
  }
});

test("Hermes honors process environment with a custom home directory", async (t) => {
  const input = fixture(t);
  const previousHome = process.env.HERMES_HOME;
  const previousHomes = process.env.CODEX_USAGE_HERMES_HOMES;
  const previousEnabled = process.env.CODEX_USAGE_HERMES;
  const isolatedHome = path.join(input.root, "custom-home");
  try {
    input.db.close();
    mkdirSync(isolatedHome);
    process.env.HERMES_HOME = input.root;
    delete process.env.CODEX_USAGE_HERMES_HOMES;
    process.env.CODEX_USAGE_HERMES = "1";
    assert.ok(
      (await discoverHermesHomes({ homeDir: isolatedHome, platform: "linux" })).some(
        (home) => home.path === input.root,
      ),
    );
    assert.ok(
      (await scanImportSources({ homeDir: isolatedHome, platform: "linux" })).candidates.some(
        (home) => home.path === input.root && home.kind === "hermes" && !home.confirmed,
      ),
    );
    delete process.env.HERMES_HOME;
    process.env.CODEX_USAGE_HERMES_HOMES = input.root;
    assert.ok(
      (await discoverHermesHomes({ homeDir: isolatedHome, platform: "linux", onlyConfiguredSources: true })).some(
        (home) => home.path === input.root,
      ),
    );
    assert.ok(
      (await discoverUsageSources({ homeDir: isolatedHome, platform: "linux", onlyConfiguredSources: true })).some(
        (home) => home.path === input.root && home.kind === "hermes",
      ),
    );
    assert.deepEqual(await discoverHermesHomes({ homeDir: isolatedHome, platform: "linux", env: {} }), []);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousHomes === undefined) delete process.env.CODEX_USAGE_HERMES_HOMES;
    else process.env.CODEX_USAGE_HERMES_HOMES = previousHomes;
    if (previousEnabled === undefined) delete process.env.CODEX_USAGE_HERMES;
    else process.env.CODEX_USAGE_HERMES = previousEnabled;
    if (input.db.isOpen) input.db.close();
  }
});

test("Hermes marks inconsistent reasoning and supports a database without a model table", async (t) => {
  const input = fixture(t);
  try {
    input.db
      .prepare("UPDATE session_model_usage SET output_tokens=0,reasoning_tokens=60 WHERE task='voice_chat'")
      .run();
    const inconsistent = (await read(input)).find((event) => event.usage.reasoning === 60);
    assert.equal(inconsistent.detailMask & 8, 0);
    assert.equal(inconsistent.detailMask & 16, 16);
    assert.equal(inconsistent.reconciliationGap, 60);
    input.db.exec("DROP TABLE session_model_usage");
    const fallback = await read(input);
    assert.equal(fallback.length, 2);
    assert.ok(fallback.every((event) => event.model === "Unknown model"));
    assert.equal(fallback.find((event) => event.sessionId === "fallback").usage.total, 140);
  } finally {
    input.db.close();
  }
});

test("Hermes discovery and confirmed imports feed all three ordinary usage paths", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    assert.equal((await classifyImportDirectory(input.root)).type, "hermes-home");
    assert.equal((await scanImportSources(options)).candidates.filter((item) => item.kind === "hermes").length, 1);
    assert.deepEqual(await discoverUsageSources({ ...options, confirmedSources: [] }), []);
    const homes = await discoverUsageSources(options);
    assert.equal(homes.filter((home) => home.kind === "hermes").length, 1);
    const report = await buildUsageReport({ ...options, homes });
    const index = await buildUsageIndex({ ...options, homes });
    assert.equal(
      report.events.reduce((sum, event) => sum + event.total.total, 0),
      325,
    );
    assert.equal(
      index.events.reduce((sum, event) => sum + event.total, 0),
      325,
    );
    await store.sync({ options });
    assert.equal(store.database.prepare("SELECT SUM(total) AS total FROM events").get().total, 325);
    const event = store.database.prepare("SELECT * FROM events WHERE source_event_id<>'' LIMIT 1").get();
    assert.throws(
      () =>
        store.database
          .prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,
      channel,project,model,hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning,source_event_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            event.source_path,
            event.timestamp_ms,
            event.session_id,
            event.home_id,
            event.home_label,
            event.channel,
            event.project,
            event.model,
            event.hour_key,
            event.day_key,
            event.week_key,
            event.month_key,
            event.total,
            event.input,
            event.cached,
            event.output,
            event.reasoning,
            event.source_event_id,
          ),
      /duplicate source event identity/,
    );
    const other = store.database
      .prepare("SELECT id FROM events WHERE source_path=? AND source_event_id<>? LIMIT 1")
      .get(event.source_path, event.source_event_id);
    assert.throws(
      () =>
        store.database.prepare("UPDATE events SET source_event_id=? WHERE id=?").run(event.source_event_id, other.id),
      /duplicate source event identity/,
    );
    assert.deepEqual(store.metadata().harnessModels.Hermes, ["glm-5.1"]);
    const reportCost = summarizeUsage(report, { preset: "all" }).costEstimate;
    const indexCost = summarizeUsageIndex(index, { preset: "all" }).costEstimate;
    const storeCost = store.summarize({ preset: "all" }).costEstimate;
    assert.equal(reportCost.totalUsd, indexCost.totalUsd);
    assert.equal(reportCost.totalUsd, storeCost.totalUsd);
    assert.ok(reportCost.unpricedReasons.includes("aggregate-usage-coverage-unknown"));
  } finally {
    store.close();
    input.db.close();
  }
});

test("Hermes homes with the same session IDs count as distinct sessions", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const options = {
    homeDir: first.root,
    env: {},
    extraHermesHomes: [first.root, second.root].join(path.delimiter),
    importDirs: [],
  };
  const store = new UsageStore({ ...options, databaseFile: path.join(first.root, "index.sqlite") });
  try {
    const report = await buildUsageReport(options);
    const index = await buildUsageIndex(options);
    await store.sync({ options });
    assert.equal(summarizeUsage(report, { preset: "all" }).sessionCount, 4);
    assert.equal(summarizeUsageIndex(index, { preset: "all" }).sessionCount, 4);
    assert.equal(store.summarize({ preset: "all" }).sessionCount, 4);
    assert.equal(store.metadata().sessionCount, 4);
    for (const summary of [
      summarizeUsage(report, { preset: "all" }),
      summarizeUsageIndex(index, { preset: "all" }),
      store.summarize({ preset: "all" }),
    ]) {
      assert.equal(summary.repositories.find((row) => row.name.includes("repo")).sessions, 2);
      assert.equal(summary.repositories.find((row) => row.name.includes("repo")).sessionIds.length, 2);
      assert.equal(summary.timeline[0].sessions, 4);
    }
    const candidate = path.join(first.root, "multiple-homes.sqlite");
    await createHistoryArchiveCandidate(store.database, candidate, { startMs: 1, endMs: 500000 });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    const cold = await store.summarizeHistory({ preset: "all" });
    assert.equal(cold.sessionCount, 4);
    assert.equal(cold.repositories.find((row) => row.name.includes("repo")).sessions, 2);
    assert.equal(cold.repositories.find((row) => row.name.includes("repo")).sessionIds.length, 2);
  } finally {
    store.close();
    first.db.close();
    second.db.close();
  }
});

test("Hermes imported after a different source was archived remains readable and can be revised", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    await store.open();
    const sourcePath = path.join(input.root, "previous.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(sourcePath, "codex", "old", "Old", input.root, 1, 1, "2026-01-01T00:00:00Z");
    store.database
      .prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        sourcePath,
        200000,
        "old",
        "old",
        "Old",
        "CLI",
        "",
        "gpt-6-sol",
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
    createUsageRollups(store.database);
    const candidate = path.join(input.root, "candidate.sqlite");
    await createHistoryArchiveCandidate(store.database, candidate, { startMs: 1, endMs: 500000 });
    const scratch = path.join(input.root, "ballast.sqlite");
    copyFileSync(candidate, scratch);
    const inflated = new DatabaseSync(scratch);
    const oldArchive = path.join(input.root, "old-archive.sqlite");
    try {
      inflated.exec(
        "CREATE TABLE ballast(value BLOB); INSERT INTO ballast VALUES(zeroblob(1048576)); DROP TABLE ballast",
      );
      await createHistoryBackup(inflated, oldArchive);
    } finally {
      inflated.close();
    }
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, oldArchive));
    await store.sync({ options });
    let events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      345,
    );
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) n FROM events WHERE timestamp_ms<500000").get().n), 0);
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120,last_seen=300 WHERE task='voice_chat'").run();
    await store.sync({ options });
    events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      365,
    );
    assert.equal(events.filter((event) => event.channel === "Hermes Subagent").length, 2);
    const bundle = path.join(input.root, "introduced-bundle");
    const imported = path.join(input.root, "introduced-import");
    await publishHistoryArchiveBundle(store.database, bundle);
    await publishHistoryArchiveImport(bundle, imported);
    const loaded = await loadHistoryArchiveImport(imported);
    const restored = new UsageStore({ databaseFile: loaded.runtimeFile });
    try {
      await restored.open();
      assert.equal(
        (await restored.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
        365,
      );
    } finally {
      restored.close();
    }
    const compactDir = path.join(input.root, "compact");
    const result = await compactRegisteredHistory(store, compactDir);
    assert.equal(result.switched, 1);
    assert.equal(
      (await store.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
      365,
    );
    await compactRegisteredHistory(store, compactDir, { rollback: true });
    assert.equal(
      (await store.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
      365,
    );
  } finally {
    store.close();
    input.db.close();
  }
});

test("Hermes aggregate identity moves across two authorized cold segments", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    input.db.prepare("UPDATE session_model_usage SET last_seen=400 WHERE task='title_generation'").run();
    await store.sync({ options });
    const candidates = [];
    for (const [startMs, endMs] of [
      [1, 300000],
      [300000, 500000],
    ]) {
      const candidate = path.join(input.root, `candidate-${startMs}.sqlite`);
      await createHistoryArchiveCandidate(store.database, candidate, { startMs, endMs });
      candidates.push(candidate);
    }
    for (const candidate of candidates)
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120,last_seen=400 WHERE task='voice_chat'").run();
    await store.sync({ options });
    const events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      345,
    );
    assert.equal(events.filter((event) => event.timestamp === new Date(400000).toISOString()).length, 2);
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) n FROM events").get().n), 0);
  } finally {
    store.close();
    input.db.close();
  }
});

test("archived Hermes rows can move between cold and hot and be deleted without duplicate usage", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    await store.sync({ options });
    const candidate = path.join(input.root, "candidate.sqlite");
    await createHistoryArchiveCandidate(store.database, candidate, { startMs: 1, endMs: 500000 });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120,last_seen=700 WHERE task='voice_chat'").run();
    await store.sync({ options });
    let events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      345,
    );
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) n FROM events").get().n), 1);
    input.db.prepare("UPDATE session_model_usage SET last_seen=400 WHERE task='voice_chat'").run();
    input.db.prepare("DELETE FROM session_model_usage WHERE task='title_generation'").run();
    await store.sync({ options });
    events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      330,
    );
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) n FROM events").get().n), 0);
    assert.ok(Number(store.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts").get().n) > 0);
  } finally {
    store.close();
    input.db.close();
  }
});

test("a schema 24 cold package remains readable after upgrading and importing Hermes", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const file = path.join(input.root, "index.sqlite");
  let store = new UsageStore({ ...options, databaseFile: file });
  try {
    await store.open();
    const sourcePath = path.join(input.root, "previous.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(sourcePath, "codex", "old", "Old", input.root, 1, 1, "2026-01-01T00:00:00Z");
    store.database
      .prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        sourcePath,
        200000,
        "old",
        "old",
        "Old",
        "CLI",
        "",
        "gpt-6-sol",
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
    store.close();
    const old = new DatabaseSync(file);
    try {
      old.exec(
        "DROP TRIGGER events_source_event_id_insert; DROP TRIGGER events_source_event_id_update; DROP INDEX events_source_event_id; ALTER TABLE events DROP COLUMN source_event_id; PRAGMA user_version=24",
      );
      const candidate = path.join(input.root, "legacy-candidate.sqlite");
      const manifest = await createHistoryArchiveCandidate(old, candidate, { startMs: 1, endMs: 500000 });
      const id = manifest.database.sha256;
      old.prepare("INSERT INTO archive_segments VALUES (?,?,?,?,?,?,?)").run(id, candidate, id, 1, 500000, 1, 1);
      old
        .prepare("INSERT INTO store_meta(key,value) VALUES(?,?)")
        .run("history_archive_event_authority", JSON.stringify({ formatVersion: 1, segmentIds: [id] }));
      old.exec("DELETE FROM events");
    } finally {
      old.close();
    }
    store = new UsageStore({ ...options, databaseFile: file });
    await store.sync({ options });
    const events = await store.publishedHistoryUsageEvents();
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      345,
    );
    assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 25);
  } finally {
    store.close();
    input.db.close();
  }
});

test("Hermes cold revisions survive frozen snapshots and complete archive import", async (t) => {
  const input = fixture(t);
  const options = {
    homeDir: input.root,
    env: {},
    extraHermesHomes: input.root,
    importDirs: [],
    databaseFile: path.join(input.root, "index.sqlite"),
  };
  const store = new UsageStore(options);
  let executor, frozenExecutor, restored;
  try {
    await store.sync({ options });
    const candidate = path.join(input.root, "candidate.sqlite");
    await createHistoryArchiveCandidate(store.database, candidate, { startMs: 1, endMs: 500000 });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    input.db.prepare("UPDATE session_model_usage SET input_tokens=120 WHERE task='voice_chat'").run();
    await store.sync({ options });
    const bundle = path.join(input.root, "bundle");
    await publishHistoryArchiveBundle(store.database, bundle);
    const importDir = path.join(input.root, "imported");
    await publishHistoryArchiveImport(bundle, importDir);
    const loaded = await loadHistoryArchiveImport(importDir);
    restored = new UsageStore({ databaseFile: loaded.runtimeFile });
    await restored.open();
    assert.equal(
      (await restored.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
      345,
    );
    store.close();
    executor = createUsageExecutor(options);
    await executor.open();
    await executor.sync({ options });
    const frozenFile = path.join(input.root, "frozen.sqlite");
    const frozen = await executor.snapshot({ databaseFile: frozenFile });
    frozenExecutor = createUsageExecutor({ databaseFile: frozenFile });
    await frozenExecutor.open({ frozen });
    const before = await frozenExecutor.dashboard({ preset: "all" });
    assert.equal(before.summary.totals.total, 345);
    input.db.prepare("UPDATE session_model_usage SET input_tokens=130 WHERE task='voice_chat'").run();
    await executor.sync({ options });
    const after = await frozenExecutor.dashboard({ preset: "all" });
    assert.equal(after.summary.totals.total, 345);
  } finally {
    await frozenExecutor?.close();
    await executor?.close();
    restored?.close();
    store.close();
    input.db.close();
  }
});
test("Hermes introduced cold revision remains frozen while the live source changes", async (t) => {
  const input = fixture(t);
  const options = {
    homeDir: input.root,
    env: {},
    extraHermesHomes: input.root,
    importDirs: [],
    databaseFile: path.join(input.root, "index.sqlite"),
  };
  const store = new UsageStore(options);
  let executor, frozenExecutor;
  try {
    await store.sync({ options });
    const candidate = path.join(input.root, "candidate.sqlite");
    await createHistoryArchiveCandidate(store.database, candidate, { startMs: 1, endMs: 500000 });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    input.db.exec(
      "INSERT INTO session_model_usage VALUES ('s','glm-5.1','provider','secret-endpoint','api','new-task',10,0,0,5,0,100,200)",
    );
    await store.sync({ options });
    assert.equal(
      (await store.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
      340,
    );
    store.close();
    executor = createUsageExecutor(options);
    await executor.open();
    const frozenFile = path.join(input.root, "frozen.sqlite");
    const frozen = await executor.snapshot({ databaseFile: frozenFile });
    frozenExecutor = createUsageExecutor({ databaseFile: frozenFile });
    await frozenExecutor.open({ frozen });
    assert.equal((await frozenExecutor.dashboard({ preset: "all" })).summary.totals.total, 340);
    input.db.prepare("UPDATE session_model_usage SET input_tokens=30 WHERE task='new-task'").run();
    await executor.sync({ options });
    assert.equal((await executor.dashboard({ preset: "all" })).summary.totals.total, 360);
    assert.equal((await frozenExecutor.dashboard({ preset: "all" })).summary.totals.total, 340);
  } finally {
    await frozenExecutor?.close();
    await executor?.close();
    store.close();
    input.db.close();
  }
});

test("Hermes source outage retains indexed usage and recovers when the database returns", async (t) => {
  const { renameSync } = await import("node:fs");
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  let writer;
  try {
    await store.sync({ options });
    input.db.close();
    renameSync(input.file, `${input.file}.away`);
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 325);
    renameSync(`${input.file}.away`, input.file);
    writer = new DatabaseSync(input.file);
    writer.prepare("UPDATE session_model_usage SET input_tokens=120 WHERE task='voice_chat'").run();
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 345);
  } finally {
    writer?.close();
    store.close();
    if (input.db.isOpen) input.db.close();
  }
});
test("Hermes identity distinguishes all billing dimensions and replaces session fallback", async (t) => {
  const input = fixture(t);
  const options = { homeDir: input.root, env: {}, extraHermesHomes: input.root, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(input.root, "index.sqlite") });
  try {
    const original = (await read(input)).find((event) => event.usage.total === 170).sourceEventId;
    const ids = new Set([original]);
    for (const field of ["session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task"]) {
      const row = input.db.prepare(`SELECT ${field} value FROM session_model_usage WHERE task='voice_chat'`).get();
      input.db.prepare(`UPDATE session_model_usage SET ${field}=? WHERE task='voice_chat'`).run(`${row.value}-changed`);
      const changed = (await read(input)).find((event) => event.usage.total === 170).sourceEventId;
      assert.ok(!ids.has(changed), field);
      ids.add(changed);
      input.db
        .prepare(`UPDATE session_model_usage SET ${field}=? WHERE ${field}=?`)
        .run(row.value, `${row.value}-changed`);
    }
    await store.sync({ options });
    input.db.exec("INSERT INTO session_model_usage VALUES ('fallback','glm-5.1','p','','api','',100,0,0,40,0,100,200)");
    await store.sync({ options });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 325);
    const fallback = (await store.publishedHistoryUsageEvents()).filter((event) => event.sessionId === "fallback");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].model, "glm-5.1");
  } finally {
    store.close();
    input.db.close();
  }
});
