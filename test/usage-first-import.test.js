import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";

const INDEX = "events_metadata_group_time_idx";
const PENDING = "usage_metadata_initial_index_pending";
const hasIndex = (store) => Boolean(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(INDEX));
const pending = (store) => store.database.prepare("SELECT value FROM store_meta WHERE key=?").get(PENDING)?.value;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-first-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-11-03T01:00:00Z",
      payload: { id: "initial-import", source: "cli", originator: "codex-tui", cwd: "" },
    },
    { type: "turn_context", payload: { model: "gpt-6-sol" } },
    {
      type: "event_msg",
      timestamp: "2026-11-03T01:01:00Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 10, input_tokens: 5, output_tokens: 5 } },
      },
    },
  ];
  await writeFile(path.join(sessions, "rollout.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return {
    homeDir: root,
    databaseFile: path.join(root, "state.sqlite"),
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
}

test("first import defers only the metadata index and completes it after facts", async (t) => {
  const options = await fixture(t);
  const store = new UsageStore(options);
  try {
    await store.open();
    assert.equal(hasIndex(store), false);
    assert.equal(pending(store), "1");
    store.metadata();
    await store.summarizeHistory({ preset: "all", now: new Date("2026-11-03T12:00:00Z") }, { includeDetails: false });
    assert.equal(hasIndex(store), false, "an empty query must not end import deferral");
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_all_summary_state").get().n, 0);
    const replace = store.replaceFile;
    let imported = 0;
    store.replaceFile = async function (...args) {
      assert.equal(hasIndex(this), false, "bulk import must not maintain this query index");
      assert.ok(
        this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='events_session_home_time_idx'").get(),
        "parser's cumulative index remains active",
      );
      imported += 1;
      return replace.apply(this, args);
    };
    await store.sync();
    assert.equal(imported, 1);
    assert.equal(hasIndex(store), true);
    assert.equal(pending(store), undefined);
    assert.equal(store.metadata().eventCount, 1);
  } finally {
    store.close();
  }
  const reopened = new UsageStore(options);
  try {
    await reopened.open();
    assert.equal(hasIndex(reopened), true);
    assert.equal(pending(reopened), undefined);
    assert.equal((await reopened.sync()).updatedFileCount, 0);
  } finally {
    reopened.close();
  }
});

test("failed index publication rolls back the index and resumes committed facts without reparsing", async (t) => {
  const options = await fixture(t);
  const store = new UsageStore(options);
  try {
    await store.open();
    const execute = store.database.exec.bind(store.database);
    store.database.exec = (sql) => {
      if (sql === "RELEASE initial_metadata_index") throw new Error("injected index publication failure");
      return execute(sql);
    };
    await assert.rejects(store.sync(), /injected index publication failure/);
    assert.equal(hasIndex(store), false);
    assert.equal(pending(store), "1");
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_source_progress").get().n, 1);
  } finally {
    store.close();
  }
  const reopened = new UsageStore(options);
  try {
    await reopened.open();
    assert.equal(hasIndex(reopened), false);
    reopened.replaceFile = () => {
      throw new Error("committed sources must not be parsed again");
    };
    assert.equal((await reopened.sync()).updatedFileCount, 0);
    assert.equal(hasIndex(reopened), true);
    assert.equal(pending(reopened), undefined);
    assert.equal(reopened.metadata().eventCount, 1);
    assert.equal(reopened.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    reopened.close();
  }
});
