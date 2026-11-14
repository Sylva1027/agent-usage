import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-usage-no-tps-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function tableNames(database) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

test("fresh schema 25 creates ordinary usage tables without TPS tables", async (t) => {
  const homeDir = await temporaryDirectory(t);
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage.sqlite") });

  try {
    await store.open();
    assert.equal(STORE_SCHEMA_VERSION, 25);
    assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 25);

    const tables = tableNames(store.database);
    assert.equal(
      tables.some((name) => name.startsWith("perf_")),
      false,
    );
    assert.equal(tables.includes("workbuddy_generation_durations"), false);
    assert.equal(tables.includes("workbuddy_generation_duration_observations"), false);

    const summary = await store.summarize({ preset: "all" });
    for (const field of ["perf", "perfSamples", "perfMeta", "perfCarrier"]) {
      assert.equal(Object.hasOwn(summary, field), false);
    }
    const report = await store.publishedHistoryUsageReport();
    for (const field of ["perf", "perfSamples", "perfMeta", "perfCarrier"]) {
      assert.equal(Object.hasOwn(report, field), false);
    }
    for (const method of [
      "perfState",
      "perfPublicationState",
      "perfSummaryForRange",
      "capturePerfCarrier",
      "readHistoryArchivePerfSamples",
    ]) {
      assert.equal(store[method], undefined);
    }
  } finally {
    store.close();
  }
});

test("schema 23 migrates to 25 without reading or rewriting legacy TPS tables", async (t) => {
  const homeDir = await temporaryDirectory(t);
  const databaseFile = path.join(homeDir, "usage.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    PRAGMA user_version = 23;
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO store_meta (key, value) VALUES
      ('perf_state', 'degraded'),
      ('perf_method_version', 'legacy-tps'),
      ('perf_file_warnings', '{"old-speed.jsonl":[{"sourceKind":"codex","homeId":"h1","code":"READ_ONLY_OPEN_FAILED","count":1}],"project.jsonl":[{"sourceKind":"project-log","homeId":"p1","code":"PROJECT_LOG_TRUNCATED","count":2}]}'),
      ('perf_missing_sources', '[{"path":"gone.jsonl","kind":"codex","homeId":"h1","homeLabel":"Codex","homePath":"/codex","missingSinceMs":123}]');
    CREATE TABLE perf_samples (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO perf_samples (id, value) VALUES (1, 'preserved');
  `);
  legacy.close();

  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 25);
    assert.deepEqual(store.readPublishedFileWarnings(), {
      "project.jsonl": [{ sourceKind: "project-log", homeId: "p1", code: "PROJECT_LOG_TRUNCATED", count: 2 }],
    });
    assert.deepEqual(
      store.database
        .prepare("SELECT id, value FROM perf_samples")
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, value: "preserved" }],
    );
    assert.deepEqual(store.sourceState().missingSources, [
      {
        path: "gone.jsonl",
        kind: "codex",
        homeId: "h1",
        homeLabel: "Codex",
        homePath: "/codex",
        missingSinceMs: 123,
      },
    ]);
    assert.equal(tableNames(store.database).includes("workbuddy_generation_durations"), false);
    assert.equal(tableNames(store.database).includes("perf_request_timing_dirty_threads"), false);
  } finally {
    store.close();
  }
});
