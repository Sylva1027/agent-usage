import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

function publishedFacts(store) {
  return {
    events: store.database.prepare("SELECT * FROM events ORDER BY id").all(),
    sourceFiles: store.database.prepare("SELECT * FROM source_files ORDER BY path").all(),
  };
}

test("refresh sync retains missing paths until return or rename", async () => {
  const fixture = createCodexIntegrationFixture();
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
    assert.ok(before.events.length > 0, "the retention oracle must include real usage events");
    assert.equal(store.summarize({ preset: "all" }).totals.total, 123);

    unlinkSync(missingPath);
    const missing = await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(
      missing.missingSources.map((source) => source.path),
      [missingPath],
    );
    assert.deepEqual(publishedFacts(store), before, "missing sources retain events and source ownership");
    for (let round = 0; round < 2; round++) {
      const warm = await store.sync({ options: fixture.reportOptions });
      assert.equal(warm.updatedFileCount, 0);
      assert.deepEqual(warm.missingSources, missing.missingSources);
      assert.deepEqual(publishedFacts(store), before);
    }

    writeFileSync(missingPath, original);
    utimesSync(missingPath, originalInfo.atime, originalInfo.mtime);
    const returned = await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(returned.missingSources, []);
    const afterReturn = publishedFacts(store);
    assert.deepEqual(afterReturn.events, before.events);
    assert.equal(afterReturn.sourceFiles.length, before.sourceFiles.length);
    for (const [index, source] of afterReturn.sourceFiles.entries()) {
      const prior = before.sourceFiles[index];
      if (source.path === missingPath) {
        // A recreated file has a new identity; verifying it may refresh only its index timestamp.
        assert.ok(Date.parse(source.indexed_at) >= Date.parse(prior.indexed_at));
        assert.deepEqual({ ...source, indexed_at: prior.indexed_at }, { ...prior });
      } else assert.deepEqual(source, prior);
    }
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);

    const renameTo = path.join(path.dirname(renameFrom), "renamed-rollout.jsonl");
    const renameInfo = statSync(renameFrom);
    copyFileSync(renameFrom, renameTo);
    utimesSync(renameTo, renameInfo.atime, renameInfo.mtime);
    unlinkSync(renameFrom);
    const renamed = await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(renamed.missingSources, []);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(renameFrom).n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(renameTo).n, 1);
    assert.deepEqual(publishedFacts(store).events, before.events);
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    fixture.close();
  }
});

test("refresh sync: failed final metadata cannot acknowledge missing paths", async () => {
  const fixture = createCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const writeMeta = store.writeMeta;
  try {
    await store.sync({ options: fixture.reportOptions });
    const before = publishedFacts(store);
    unlinkSync(fixture.rolloutFiles[1]);
    store.writeMeta = function (key, value) {
      if (key === "generated_at") throw new Error("refresh injected final metadata failure");
      return writeMeta.call(this, key, value);
    };
    await assert.rejects(
      () => store.sync({ options: fixture.reportOptions }),
      /refresh injected final metadata failure/,
    );
    store.writeMeta = writeMeta;
    assert.equal(store.publishedFileWarningsView, null);
    assert.deepEqual(publishedFacts(store), before);

    const retry = await store.sync({ options: fixture.reportOptions });
    assert.ok(retry.missingSources.some((source) => source.path === fixture.rolloutFiles[1]));
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
  } finally {
    store.writeMeta = writeMeta;
    store.close();
    fixture.close();
  }
});

test("refresh sync: retained membership, external commits and close invalidate the live-path snapshot", async () => {
  const fixture = createCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const options = fixture.reportOptions;
  try {
    await store.sync({ options });
    unlinkSync(fixture.rolloutFiles[1]);
    await store.sync({ options });
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
    const before = publishedFacts(store);

    const retainedPath = path.join(path.dirname(fixture.rolloutFiles[0]), "retained-only.jsonl");
    store.database
      .prepare(`INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
                SELECT ?, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at
                FROM source_files WHERE path = ?`)
      .run(retainedPath, fixture.rolloutFiles[0]);
    const retained = await store.sync({ options });
    assert.ok(retained.missingSources.some((source) => source.path === retainedPath));
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
    const replacementPath = `${retainedPath}.changed.jsonl`;
    store.database.prepare("UPDATE source_files SET path = ? WHERE path = ?").run(replacementPath, retainedPath);
    const changed = await store.sync({ options });
    assert.ok(changed.missingSources.some((source) => source.path === replacementPath));
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
    store.database.prepare("DELETE FROM source_files WHERE path = ?").run(replacementPath);
    const removed = await store.sync({ options });
    assert.equal(
      removed.missingSources.some((source) => source.path === replacementPath),
      false,
    );
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
    assert.deepEqual(publishedFacts(store), before);

    const externalCount = store.externalCommitCount;
    const external = new DatabaseSync(fixture.serverOptions.databaseFile);
    try {
      external.prepare("UPDATE store_meta SET value = ? WHERE key = 'generated_at'").run("2001-01-01T00:00:00Z");
    } finally {
      external.close();
    }
    const externalSync = await store.sync({ options });
    assert.deepEqual(
      externalSync.missingSources.map((source) => source.path),
      [fixture.rolloutFiles[1]],
    );
    assert.ok(store.externalCommitCount > externalCount);
    assert.equal((await store.sync({ options })).updatedFileCount, 0);

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
    assert.deepEqual(
      (await store.sync({ options })).missingSources.map((source) => source.path),
      [fixture.rolloutFiles[1]],
    );
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
    assert.deepEqual(publishedFacts(store), before);

    store.close();
    await store.open();
    const reopened = await store.sync({ options });
    assert.deepEqual(
      reopened.missingSources.map((source) => source.path),
      [fixture.rolloutFiles[1]],
    );
    assert.equal((await store.sync({ options })).updatedFileCount, 0);
  } finally {
    store.close();
    fixture.close();
  }
});
