import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../../src/usage-store.js";

import { runIndexMigrationBenchmark } from "./index-migration-benchmark.mjs";

test("index migration benchmark preserves a minimal schema-24 store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "index-migration-benchmark-"));
  const seedFile = path.join(root, "seed", "usage-index.sqlite");
  const outputDirectory = path.join(root, "output");
  await mkdir(path.dirname(seedFile), { recursive: true });
  const store = new UsageStore({ databaseFile: seedFile, homeDir: root });
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("/fixture/a.jsonl", "codex", "fixture-home", "Fixture", "/fixture", 1, 1, "2026-11-02T00:00:00Z");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("/fixture/b.jsonl", "codex", "fixture-home", "Fixture", "/fixture", 1, 1, "2026-11-02T00:00:00Z");
    const insert = store.database.prepare(
      `INSERT INTO events (
         source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
         hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "/fixture/a.jsonl",
      1,
      "fixture-session",
      "fixture-home",
      "Fixture",
      "fixture",
      "fixture",
      "fixture",
      "h",
      "d",
      "w",
      "m",
      100,
      80,
      40,
      20,
      0,
    );
    insert.run(
      "/fixture/b.jsonl",
      2,
      "fixture-session",
      "fixture-home",
      "Fixture",
      "fixture",
      "fixture",
      "fixture",
      "h",
      "d",
      "w",
      "m",
      50,
      30,
      10,
      20,
      0,
    );
    store.database.exec("DROP INDEX events_session_home_time_idx");
  } finally {
    store.close();
  }

  try {
    const result = await runIndexMigrationBenchmark({ seedFile, outputDirectory });
    assert.equal(result.report.dataPreserved, true);
    assert.deepEqual(result.report.index.columns, ["session_id", "home_id", "timestamp_ms"]);
    assert.equal(result.report.cumulativeQuery.exactMatch, true);
    assert.equal(result.report.cumulativeQuery.boundary.predecessorCount, 1);
    assert.equal(result.report.cumulativeQuery.boundary.resultCount, 1);
    assert.equal(result.report.cumulativeQuery.boundary.candidatesScanned, 1);
    assert.ok(result.report.cumulativeQuery.indexedPlan.some((line) => line.includes("events_session_home_time_idx")));
    assert.ok(!result.report.cumulativeQuery.unindexedPlan.some((line) => line.includes("events_session_home_time_idx")));
    assert.equal(result.report.cumulativeQuery.indexedMs.length, 3);
    assert.equal(result.report.cumulativeQuery.unindexedMs.length, 3);
    assert.ok(Number.isFinite(result.report.index.firstCheckpointMs));
    assert.ok(Number.isFinite(result.report.index.firstCloseMs));
    assert.equal(result.report.insertWrite.indexed.commitMs.length, 3);
    assert.equal(result.report.insertWrite.unindexed.walBytesGrowth.length, 3);
    assert.deepEqual(result.report.insertWrite.roundOrder, [
      "indexed,unindexed",
      "unindexed,indexed",
      "indexed,unindexed",
    ]);
    const reportText = await readFile(result.reportFile, "utf8");
    assert.doesNotMatch(reportText, /fixture-session|\/fixture\/|index-migration-benchmark-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
