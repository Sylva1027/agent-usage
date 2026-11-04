import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "quota-source-store-"));
  const databaseFile = path.join(directory, "index.sqlite");
  const store = new UsageStore({ databaseFile, homeDir: directory, env: {}, importDirs: [] });
  try {
    await store.open();
    await run(store, databaseFile);
  } finally {
    if (store.database?.isTransaction) store.database.exec("ROLLBACK");
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function insert(database, sourcePath, time, source, until = 0) {
  database
    .prepare(`INSERT INTO quota_usage_sources
    (source_path, home_id, session_id, timestamp_ms, quota_source, until_ms)
    VALUES (?, 'home', 'thread', ?, ?, ?)`)
    .run(sourcePath, time, source, until);
}

function frame(store) {
  store.summarizeInReadTransaction({ preset: "all", now: new Date(50), bucket: "day" }, { includeDetails: false });
}

test("source lookup follows an outer read snapshot and sees a committed writer in the next frame", async () => {
  await fixture(async (store, databaseFile) => {
    insert(store.database, "first", 10, "plan");
    const writer = new DatabaseSync(databaseFile);
    try {
      store.database.exec("BEGIN");
      frame(store);
      assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
      insert(writer, "second", 40, "credits", 100);
      frame(store);
      assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
      store.database.exec("COMMIT");
      frame(store);
      assert.equal(store.quotaSourceFor("home", "thread", 50), "credits");
    } finally {
      writer.close();
    }
  });
});

test("new read frames discard source segments from writes rolled back inside an outer transaction", async () => {
  await fixture(async (store) => {
    insert(store.database, "first", 10, "credits", 100);
    store.database.exec("BEGIN");
    frame(store);
    assert.equal(store.quotaSourceFor("home", "thread", 50), "credits");
    store.database.exec("SAVEPOINT changed_source");
    insert(store.database, "second", 40, "plan");
    frame(store);
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
    store.database.exec("ROLLBACK TO changed_source; RELEASE changed_source");
    frame(store);
    assert.equal(store.quotaSourceFor("home", "thread", 50), "credits");
    store.database.exec("COMMIT");
  });
});

test("owned write transactions never retain a source segment across rollback", async () => {
  await fixture(async (store) => {
    insert(store.database, "first", 10, "plan");
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
    store.database.exec("BEGIN");
    store.writeTransactionDepth += 1;
    try {
      insert(store.database, "second", 40, "credits", 100);
      assert.equal(store.quotaSourceFor("home", "thread", 50), "credits");
    } finally {
      store.database.exec("ROLLBACK");
      store.writeTransactionDepth -= 1;
    }
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
  });
});

test("source lookup is connection-local and source selectors use the installed indexes", async () => {
  await fixture(async (store) => {
    insert(store.database, "first", 10, "plan");
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
    const plans = [
      ["quota_sources_thread_time_idx", "home_id = 'home' AND session_id = 'thread' AND timestamp_ms <= 50"],
      [
        "quota_sources_account_time_idx",
        "home_id = 'home' AND timestamp_ms <= 50 AND quota_source IN ('credits','plan')",
      ],
    ];
    for (const [name, predicate] of plans) {
      const plan = store.database
        .prepare(`EXPLAIN QUERY PLAN SELECT timestamp_ms, quota_source, until_ms
        FROM quota_usage_sources WHERE ${predicate} ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1`)
        .all();
      assert.ok(
        plan.some((row) => String(row.detail).includes(name)),
        name,
      );
    }
    const original = store.database;
    const alternate = new DatabaseSync(":memory:");
    alternate.exec(
      String(original.prepare("SELECT sql FROM sqlite_master WHERE name='quota_usage_sources'").get().sql),
    );
    try {
      store.database = alternate;
      assert.equal(store.quotaSourceFor("home", "thread", 50), "unknown");
    } finally {
      store.database = original;
      alternate.close();
    }
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
    store.close();
    await store.open();
    assert.equal(store.quotaSourceFor("home", "thread", 50), "plan");
  });
});
