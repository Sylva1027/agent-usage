import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function publishedFacts(store) {
  return {
    events: store.database.prepare("SELECT * FROM events ORDER BY id").all(),
    samples: store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all(),
    owners: store.database.prepare("SELECT * FROM perf_rollout_threads ORDER BY source_path, home_id, thread_id").all(),
    dependencies: store.database
      .prepare("SELECT * FROM perf_sample_sources ORDER BY sample_key, source_path, role")
      .all(),
  };
}

async function syncWithPlanningCount(store, options) {
  const cache = store.codexProjections;
  const lookup = cache.lookup;
  let lookups = 0;
  // Observe the real planner's cache requests without changing its results or exceptions.
  cache.lookup = function (...args) {
    lookups += 1;
    return lookup.apply(this, args);
  };
  try {
    const status = await store.sync({ options });
    return { status, lookups };
  } finally {
    cache.lookup = lookup;
  }
}

test("refresh sync: retained missing paths stop planning; return and rename still plan", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const [renameFrom, missingPath] = fixture.rolloutFiles;
  const originalInfo = statSync(missingPath);
  appendFileSync(
    missingPath,
    `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-10-04T12:01:00.000Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 123, input_tokens: 100, output_tokens: 23 } },
      },
    })}\n`,
  );
  utimesSync(missingPath, originalInfo.atime, originalInfo.mtime);
  const original = readFileSync(missingPath);
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = publishedFacts(store);
    assert.equal(before.events.length, 1, "the retention oracle must include a real usage event");
    assert.equal(before.events[0].total, 123);
    assert.equal(before.samples.length, 26);
    assert.equal(before.owners.length, 3);
    assert.equal(before.dependencies.length, 78);

    unlinkSync(missingPath);
    const missing = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(missing.lookups > 0, "a newly missing path must replan the home");
    assert.equal(missing.status.perfState, "ready");
    assert.deepEqual(
      missing.status.missingSources.map((source) => source.path),
      [missingPath],
    );
    assert.deepEqual(publishedFacts(store), before, "missing sources retain events, samples and dependency ownership");
    const version = store.perfState().indexVersion;
    for (let round = 0; round < 2; round++) {
      const warm = await syncWithPlanningCount(store, fixture.reportOptions);
      assert.equal(warm.lookups, 0, "stable missing paths must not re-enter Codex planning");
      assert.equal(warm.status.updatedFileCount, 0);
      assert.equal(warm.status.perfState, "ready");
      assert.deepEqual(warm.status.missingSources, missing.status.missingSources);
      assert.equal(store.perfState().indexVersion, version);
      assert.deepEqual(publishedFacts(store), before);
    }

    writeFileSync(missingPath, original);
    utimesSync(missingPath, originalInfo.atime, originalInfo.mtime);
    const returned = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(returned.lookups > 0, "return must plan even with identical bytes, size and mtime");
    assert.deepEqual(returned.status.missingSources, []);
    assert.equal(returned.status.perfState, "ready");
    assert.deepEqual(publishedFacts(store), before);
    assert.equal((await syncWithPlanningCount(store, fixture.reportOptions)).lookups, 0);

    const renameTo = path.join(path.dirname(renameFrom), "renamed-rollout.jsonl");
    const renameInfo = statSync(renameFrom);
    copyFileSync(renameFrom, renameTo);
    utimesSync(renameTo, renameInfo.atime, renameInfo.mtime);
    unlinkSync(renameFrom);
    const renamed = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(renamed.lookups > 0, "a rename must not be hidden by the live-path snapshot");
    assert.equal(renamed.status.perfState, "ready");
    assert.deepEqual(renamed.status.missingSources, []);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(renameFrom).n, 0);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE source_path = ?").get(renameTo).n,
      1,
    );
    assert.equal(publishedFacts(store).samples.length, before.samples.length);
    assert.deepEqual(publishedFacts(store).events, before.events);
    assert.equal((await syncWithPlanningCount(store, fixture.reportOptions)).lookups, 0);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    fixture.close();
  }
});

test("refresh sync: failed final metadata and degraded publication cannot acknowledge missing paths", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const writeMeta = store.writeMeta;
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = publishedFacts(store);
    unlinkSync(fixture.rolloutFiles[1]);
    store.writeMeta = function (key, value) {
      if (key === "perf_indexed_at") throw new Error("refresh injected final metadata failure");
      return writeMeta.call(this, key, value);
    };
    await assert.rejects(
      () => store.sync({ options: fixture.reportOptions }),
      /refresh injected final metadata failure/,
    );
    store.writeMeta = writeMeta;
    assert.equal(store.publishedFileMapsView, null);
    assert.deepEqual(publishedFacts(store), before);

    const retry = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(retry.lookups > 0, "failed final metadata must leave the missing transition unacknowledged");
    assert.equal(retry.status.perfState, "ready");
    assert.equal((await syncWithPlanningCount(store, fixture.reportOptions)).lookups, 0);

    const added = path.join(path.dirname(fixture.rolloutFiles[0]), "rollout-added.jsonl");
    writeFileSync(
      added,
      `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-codex-thread", source: "vscode" } })}\n`,
    );
    store.database.exec(`
      CREATE TRIGGER refresh_fail_owner BEFORE INSERT ON perf_rollout_threads
      BEGIN SELECT RAISE(ABORT, 'refresh injected owner publication failure'); END;
    `);
    const failed = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(failed.lookups > 0);
    assert.equal(failed.status.perfState, "degraded");
    assert.deepEqual(publishedFacts(store), before, "a failed candidate publication must retain the old facts");
    store.database.exec("DROP TRIGGER refresh_fail_owner");

    const recovered = await syncWithPlanningCount(store, fixture.reportOptions);
    assert.ok(recovered.lookups > 0, "degraded publication must replan without another source edit");
    assert.equal(recovered.status.perfState, "ready");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_rollout_threads WHERE source_path = ?").get(added).n,
      1,
    );
    assert.equal((await syncWithPlanningCount(store, fixture.reportOptions)).lookups, 0);
  } finally {
    store.writeMeta = writeMeta;
    store.close();
    fixture.close();
  }
});

test("refresh sync: retained membership, external commits and close invalidate the live-path snapshot", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const options = fixture.reportOptions;
  try {
    await store.sync({ options });
    unlinkSync(fixture.rolloutFiles[1]);
    await store.sync({ options });
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
    const before = publishedFacts(store);

    const retainedPath = path.join(path.dirname(fixture.rolloutFiles[0]), "retained-only.jsonl");
    store.database
      .prepare(`INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
                SELECT ?, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at
                FROM source_files WHERE path = ?`)
      .run(retainedPath, fixture.rolloutFiles[0]);
    assert.ok((await syncWithPlanningCount(store, options)).lookups > 0, "a new retained row invalidates the snapshot");
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
    const replacementPath = `${retainedPath}.changed.jsonl`;
    store.database.prepare("UPDATE source_files SET path = ? WHERE path = ?").run(replacementPath, retainedPath);
    const changed = await syncWithPlanningCount(store, options);
    assert.ok(changed.lookups > 0, "equal retained counts cannot hide different path membership");
    assert.ok(changed.status.missingSources.some((source) => source.path === replacementPath));
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
    store.database.prepare("DELETE FROM source_files WHERE path = ?").run(replacementPath);
    assert.ok(
      (await syncWithPlanningCount(store, options)).lookups > 0,
      "removing a retained row invalidates the snapshot",
    );
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
    assert.deepEqual(publishedFacts(store), before);

    const externalCount = store.externalCommitCount;
    const external = new DatabaseSync(fixture.serverOptions.databaseFile);
    try {
      external.prepare("UPDATE store_meta SET value = ? WHERE key = 'generated_at'").run("2001-01-01T00:00:00Z");
    } finally {
      external.close();
    }
    assert.ok(
      (await syncWithPlanningCount(store, options)).lookups > 0,
      "external commit clears the missing-path snapshot",
    );
    assert.ok(store.externalCommitCount > externalCount);
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);

    const usageFiles = store.usageFiles;
    store.usageFiles = async function (...args) {
      const result = await usageFiles.apply(this, args);
      const connection = new DatabaseSync(fixture.serverOptions.databaseFile);
      try {
        connection.prepare("UPDATE store_meta SET value = ? WHERE key = 'generated_at'").run("2002-01-01T00:00:00Z");
      } finally {
        connection.close();
      }
      return result;
    };
    try {
      await store.sync({ options });
    } finally {
      store.usageFiles = usageFiles;
    }
    assert.ok(
      (await syncWithPlanningCount(store, options)).lookups > 0,
      "a mid-round external commit must prevent fresh acknowledgement",
    );
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
    assert.deepEqual(publishedFacts(store), before);

    store.close();
    await store.open();
    assert.ok((await syncWithPlanningCount(store, options)).lookups > 0, "close/open must establish a fresh snapshot");
    assert.equal((await syncWithPlanningCount(store, options)).lookups, 0);
  } finally {
    store.close();
    fixture.close();
  }
});
