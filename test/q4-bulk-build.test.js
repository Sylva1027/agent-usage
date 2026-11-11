import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";
import { streamUsageFileEvents } from "../src/usage-core.js";
import { UsageSourceProof } from "../src/usage-source-proof.js";
import {
  checkpointUsageRollups,
  listDirtyUsageRollupDays,
  localUsageRollupDaysForUtcDays,
  rebuildUsageRollups,
  tryAppendUsageRollups,
  tryInitializeUsageRollups,
} from "../src/usage-rollups.js";

const zoneIdentity = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tables = ["daily", "models", "repositories", "sessions", "days", "progress", "progress_days", "dirty_days"];

function bulkTest(name, run) {
  test(name, async (t) => {
    if (process.platform !== "win32" || process.env.TZ === "UTC") return run(t);
    // Windows SQLite uses the CRT timezone; launch with UTC so it agrees with Node's ICU calendar.
    const env = { ...process.env, TZ: "UTC" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", `--test-name-pattern=^${name}$`, import.meta.filename],
      { env, encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# pass 1\b/);
  });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "q4-build-"));
  const store = new UsageStore({ homeDir: directory, databaseFile: ":memory:", automaticDiscoveryEnabled: false });
  await store.open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.database.exec(`INSERT INTO source_files VALUES ('raw','main','home','Home','/home',1,1,'fixture')`);
  return store;
}

function put(store, count = 321) {
  const insert = store.database.prepare(`INSERT INTO events
    (source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,hour_key,day_key,week_key,month_key,
    cwd,repository_key,repository_path,repository_kind,detail_mask,reconciliation_gap,total,input,cached,output,reasoning)
    VALUES ('raw',?,?,?,'Home','CLI','/work',?,'','','','',?,?,?,?,?,?,?,?,?,?,?)`);
  const timestamps = [
    "2026-03-07T23:59:59.999Z",
    "2026-03-08T07:00:00Z",
    "2026-03-08T23:59:59.999Z",
    "2026-03-10T01:00:00Z",
  ];
  for (let i = 0; i < count; i++)
    insert.run(
      Date.parse(timestamps[i % 4]),
      `s${i % 17}`,
      `h${i % 2}`,
      `model-${i % 3}`,
      `/work/${i % 2}`,
      `repo-${i % 2}`,
      i % 2 ? "z" : "a",
      i % 2 ? "git" : "directory",
      i % 32,
      i % 5 === 0 ? 1 : 0,
      100 + i,
      80 + i,
      i % 4,
      20,
      i % 7,
    );
}

function snapshot(db) {
  return Object.fromEntries(
    tables.map((name) => [
      name,
      db
        .prepare(`SELECT * FROM usage_rollup_${name}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

bulkTest("Q4 initial aggregate matches independent per-day construction and later appends exactly", async (t) => {
  const candidate = await fixture(t),
    reference = await fixture(t);
  put(candidate);
  put(reference);
  const days = listDirtyUsageRollupDays(reference.database);
  rebuildUsageRollups(reference.database, { days, calendarZone: "utc" });
  rebuildUsageRollups(reference.database, { days: localUsageRollupDaysForUtcDays(days), calendarZone: "local" });
  checkpointUsageRollups(reference.database, { zoneIdentity });
  const work = tryInitializeUsageRollups(candidate.database, { zoneIdentity });
  assert.equal(work.applied, true);
  assert.equal(work.readEvents, 321);
  assert.deepEqual(snapshot(candidate.database), snapshot(reference.database));
  const before = snapshot(candidate.database);
  assert.equal(tryInitializeUsageRollups(candidate.database, { zoneIdentity }).applied, false);
  assert.deepEqual(snapshot(candidate.database), before);
  put(candidate, 1);
  put(reference, 1);
  assert.equal(tryAppendUsageRollups(candidate.database, { zoneIdentity }).readEvents, 1);
  assert.equal(tryAppendUsageRollups(reference.database, { zoneIdentity }).readEvents, 1);
  assert.deepEqual(snapshot(candidate.database), snapshot(reference.database));
});

bulkTest("Q4 initial build rolls both calendars back on failure and can retry", async (t) => {
  const store = await fixture(t);
  put(store);
  const before = snapshot(store.database),
    prepare = store.database.prepare;
  let failed = false;
  store.database.prepare = function (sql) {
    if (!failed && /INSERT INTO usage_rollup_models/.test(sql)) {
      failed = true;
      throw new Error("injected build failure");
    }
    return prepare.call(this, sql);
  };
  assert.throws(() => tryInitializeUsageRollups(store.database, { zoneIdentity }), /injected build failure/);
  store.database.prepare = prepare;
  assert.deepEqual(snapshot(store.database), before);
  assert.equal(tryInitializeUsageRollups(store.database, { zoneIdentity }).applied, true);
});

test("Q4 owned derived writes count once across nested calls, failure and rollback", async (t) => {
  const store = await fixture(t);
  put(store, 1);
  store.installUsageProjectionTracker();
  const key = store.usageProjectionChangeKey();
  const write = store.database.prepare("INSERT INTO usage_all_summary_members VALUES ('scope',?,0,0)");
  store.withBusinessProjection(() => {
    write.run("first");
    store.withBusinessProjection(() => write.run("nested"));
  });
  assert.equal(store.usageProjectionChangeKey(), key);
  assert.equal(store.database.prepare("SELECT value FROM usage_projection_ignored_rows").get().value, 0);
  assert.throws(
    () =>
      store.withBusinessProjection(() => {
        store.database.exec("BEGIN");
        write.run("rollback");
        store.database.exec("ROLLBACK");
        throw new Error("stop");
      }),
    /stop/,
  );
  assert.equal(store.usageProjectionChangeKey(), key);
  assert.equal(store.database.prepare("SELECT owned FROM usage_projection_ignored_rows").get().owned, 0);
  write.run("outside");
  assert.equal(store.usageProjectionChangeKey(), key);
  store.withBusinessProjection(() => store.database.exec("UPDATE events SET total=total+7 WHERE id=1"));
  assert.notEqual(store.usageProjectionChangeKey(), key, "fact revision cannot be hidden by owned work");
  const factKey = store.usageProjectionChangeKey();
  store.writeMeta("unknown-business-input", "changed");
  assert.notEqual(store.usageProjectionChangeKey(), factKey);
});

test("Q4 real source spans event and observation batches, preserves parser order and rolls back failed proof", async (t) => {
  const store = await fixture(t),
    filePath = path.join(store.options.homeDir, "bulk.jsonl");
  const source = { id: "bulk-home", label: "Bulk", path: store.options.homeDir, kind: "main" };
  store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  store.sourceProof = new UsageSourceProof();
  store.sourceProof.provider = async () => null;
  const usage = (n) => ({
    total_tokens: n,
    input_tokens: n,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  });
  const rows = [
    { type: "session_meta", payload: { id: "bulk-session", cwd: "/bulk", source: "cli", originator: "codex-tui" } },
    { type: "turn_context", payload: { model: "gpt-6-sol" } },
    ...Array.from({ length: 321 }, (_, i) => ({
      timestamp: new Date(Date.parse("2026-11-04T01:00:00Z") + i * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: usage(i + 1), last_token_usage: usage(1) },
        rate_limits: {
          limit_id: "codex",
          primary: { window_minutes: 300, resets_at: Date.parse("2026-11-04T05:00:00Z") / 1000, used_percent: i % 100 },
        },
      },
    })),
  ];
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const expected = [],
    observations = [];
  await streamUsageFileEvents(filePath, source, (event) => expected.push([event.timestampMs, event.usage.total]), {
    repositoryResolver: store.repositoryResolver,
    onRateLimit: (row) => observations.push([row.lineNumber, row.usedPercent]),
  });
  await store.replaceFile({ filePath, source, info: await stat(filePath) });
  assert.equal(expected.length, 321);
  assert.equal(observations.length, 321);
  assert.deepEqual(
    store.database.prepare("SELECT timestamp_ms,total FROM events ORDER BY id").all().map(Object.values),
    expected,
  );
  assert.deepEqual(
    store.database
      .prepare("SELECT line_number,used_percent FROM rate_limit_observations ORDER BY line_number")
      .all()
      .map(Object.values),
    observations,
  );
  const factTables = [
    "events",
    "rate_limit_observations",
    "source_files",
    "usage_source_progress",
    "history_replaced_facts",
  ];
  const facts = () => factTables.map((table) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = facts();
  store.sourceProof.capture = async () => {
    throw Object.assign(new Error("changed bytes"), { code: "LIVE_SOURCE_CHANGED" });
  };
  await assert.rejects(store.replaceFile({ filePath, source, info: await stat(filePath) }), {
    code: "LIVE_SOURCE_CHANGED",
  });
  assert.deepEqual(facts(), before);
});
