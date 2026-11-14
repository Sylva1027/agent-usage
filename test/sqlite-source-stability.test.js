import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { opencodeSourceStat } from "../src/opencode-usage.js";
import { UsageStore } from "../src/usage-store.js";
import { zcodeSourceStat } from "../src/zcode-usage.js";
import {
  FIXTURE_TIME,
  createRemainingHarnessFixture,
  insertDatabaseEvent,
} from "../test-support/remaining-harness-fixture.mjs";

const adapters = {
  zcode: { stat: zcodeSourceStat, table: "model_usage", relative: ["cli", "db", "db.sqlite"] },
  opencode: { stat: opencodeSourceStat, table: "session_message", relative: ["opencode.db"] },
};
const repositoryResolver = async (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
const filters = { preset: "all", now: "2026-10-21T00:00:00Z" };

function facts(store) {
  return store.database
    .prepare("SELECT * FROM events ORDER BY timestamp_ms,session_id")
    .all()
    .map(({ id: _id, ...row }) => ({ ...row }));
}

function fixture(t, kind) {
  const directory = mkdtempSync(path.join(tmpdir(), `sqlite-stability-${kind}-`));
  const root = path.join(directory, "source");
  const original = createRemainingHarnessFixture(root, kind, 3);
  const database = new DatabaseSync(original.filePath);
  database.exec("PRAGMA journal_mode=WAL");
  database.close();
  const filePath = path.join(root, ...adapters[kind].relative);
  mkdirSync(path.dirname(filePath), { recursive: true });
  renameSync(original.filePath, filePath);
  utimesSync(filePath, new Date(FIXTURE_TIME), new Date(FIXTURE_TIME));
  assert.equal(existsSync(`${filePath}-wal`), false);
  const homeDir = path.join(directory, "empty-home");
  mkdirSync(homeDir);
  const options = {
    homeDir,
    env: {},
    importDirs: [root],
    automaticDiscoveryEnabled: false,
    databaseFile: path.join(directory, "index.sqlite"),
  };
  const stores = [],
    writers = [];
  t.after(() => {
    for (const store of stores) store.close();
    for (const writer of writers) if (writer.isOpen) writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function openStore(databaseFile = options.databaseFile) {
    const store = new UsageStore({ ...options, databaseFile });
    store.repositoryResolver = repositoryResolver;
    t.mock.method(store, "replaceFile");
    stores.push(store);
    return store;
  }
  function writer() {
    const db = new DatabaseSync(filePath);
    db.exec("PRAGMA wal_autocheckpoint=0");
    writers.push(db);
    return db;
  }
  let referenceNumber = 0;
  async function assertReference(store, outputs) {
    const row = store.database.prepare("SELECT * FROM source_files WHERE path=?").get(filePath);
    const source = { id: row.home_id, label: row.home_label, path: row.home_path, kind: row.kind };
    const fresh = openStore(path.join(directory, `reference-${referenceNumber++}.sqlite`));
    try {
      await fresh.open();
      await fresh.replaceFile({ filePath, source, info: await adapters[kind].stat(filePath) });
      assert.deepEqual(facts(store), facts(fresh), "all source facts must equal a fresh parse");
      const summary = store.summarize(filters);
      const reference = fresh.summarize(filters);
      assert.deepEqual(summary.totals, reference.totals);
      assert.deepEqual(summary.costEstimate, reference.costEstimate);
      const output = outputs.reduce((sum, value) => sum + value, 0);
      assert.equal(summary.eventCount, outputs.length);
      assert.deepEqual(summary.totals, {
        total: 140 * outputs.length + output,
        input: 140 * outputs.length,
        cached: 30 * outputs.length,
        output,
        reasoning: 5 * outputs.length,
      });
      // gpt-6-sol fixture rates: $2/$0.2/$2.5/$10 per million, calculated in integer nanodollars.
      const nanos = BigInt(outputs.length) * (100n * 2000n + 30n * 200n + 10n * 2500n) + BigInt(output) * 10000n;
      assert.equal(summary.costEstimate.totalUsd.toFixed(9), (Number(nanos) / 1e9).toFixed(9));
    } finally {
      fresh.close();
    }
  }
  return { directory, filePath, openStore, writer, assertReference };
}

function revise(database, kind, output) {
  if (kind === "zcode") {
    database
      .prepare("UPDATE model_usage SET output_tokens=?,computed_total_tokens=? WHERE id='event-0'")
      .run(output, 140 + output);
  } else {
    const data = JSON.parse(database.prepare("SELECT data FROM session_message WHERE id='event-0'").get().data);
    data.tokens.output = output - 5;
    database.prepare("UPDATE session_message SET data=? WHERE id='event-0'").run(JSON.stringify(data));
  }
}

async function syncCount(store, expected, calls) {
  const result = await store.sync();
  assert.equal(result.updatedFileCount, expected);
  assert.equal(store.replaceFile.mock.callCount(), calls, "actual parser entry count");
  assert.deepEqual(store.warnings, []);
  return result;
}

for (const [kind, adapter] of Object.entries(adapters)) {
  test(`${kind}: source stat ignores empty WAL timestamps but retains nonempty WAL changes`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), `sqlite-stat-${kind}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "stat-only.sqlite"),
      wal = `${file}-wal`;
    writeFileSync(file, "main");
    const early = new Date(FIXTURE_TIME),
      later = new Date(FIXTURE_TIME + 60000);
    utimesSync(file, early, early);
    const baseline = await adapter.stat(file);
    writeFileSync(wal, "");
    utimesSync(wal, later, later);
    assert.deepEqual(await adapter.stat(file), baseline);
    rmSync(wal);
    assert.deepEqual(await adapter.stat(file), baseline);
    // These bytes exercise stat only; actual parser tests below always use SQLite's own WAL.
    writeFileSync(wal, "wal");
    utimesSync(wal, later, later);
    let observed = await adapter.stat(file);
    assert.equal(observed.size, baseline.size + 3);
    assert.equal(observed.mtimeMs, statSync(wal).mtimeMs);
    assert.notEqual(observed.sqliteObservation, baseline.sqliteObservation);
    utimesSync(wal, early, early);
    observed = await adapter.stat(file);
    assert.equal(observed.size, baseline.size + 3);
    assert.equal(observed.mtimeMs, baseline.mtimeMs);
  });

  test(`${kind}: readonly-created empty WAL stays stable through touch, deletion, recreation and restart`, async (t) => {
    const input = fixture(t, kind),
      wal = `${input.filePath}-wal`;
    let store = input.openStore();
    const main = await adapter.stat(input.filePath);
    await syncCount(store, 1, 1);
    assert.equal(statSync(wal).size, 0, "readonly parsing must reproduce the empty WAL");
    assert.deepEqual(await adapter.stat(input.filePath), main);
    await syncCount(store, 0, 1);
    const before = facts(store);
    const later = new Date(FIXTURE_TIME + 86400000);
    utimesSync(wal, later, later);
    await syncCount(store, 0, 1);
    rmSync(wal);
    await syncCount(store, 0, 1);
    writeFileSync(wal, "");
    utimesSync(wal, later, later);
    await syncCount(store, 0, 1);
    assert.deepEqual(facts(store), before);
    store.close();
    store = input.openStore();
    await syncCount(store, 0, 0);
    // An old index may have saved an empty WAL's newer mtime before upgrading.
    store.database.prepare("UPDATE source_files SET mtime_ms=? WHERE path=?").run(later.getTime(), input.filePath);
    store.close();
    store = input.openStore();
    await syncCount(store, 1, 1);
    await syncCount(store, 0, 1);
    await input.assertReference(store, [20, 21, 22]);
  });

  test(`${kind}: real WAL historical update, delete, append, truncate and later main writes remain visible`, async (t) => {
    const input = fixture(t, kind);
    let store = input.openStore();
    await syncCount(store, 1, 1);
    await syncCount(store, 0, 1);
    const writer = input.writer();
    const mainBefore = { size: statSync(input.filePath).size, mtimeMs: statSync(input.filePath).mtimeMs };
    const bounds = () => ({ ...writer.prepare(`SELECT COUNT(*) AS n,MAX(id) AS maximum FROM ${adapter.table}`).get() });
    const initialBounds = bounds();
    revise(writer, kind, 73);
    assert.deepEqual(bounds(), initialBounds, "historical UPDATE must not change row count or maximum id");
    assert.ok(statSync(`${input.filePath}-wal`).size > 0);
    assert.deepEqual({ size: statSync(input.filePath).size, mtimeMs: statSync(input.filePath).mtimeMs }, mainBefore);
    await syncCount(store, 1, 2);
    await input.assertReference(store, [73, 21, 22]);
    await syncCount(store, 0, 2);
    const deleted = facts(store).find((row) => row.session_id === "session-1");
    writer.prepare(`DELETE FROM ${adapter.table} WHERE id='event-1'`).run();
    assert.equal(await store.checkSources(), null, "an open writer's WAL change cannot certify unchanged data");
    await syncCount(store, 1, 3);
    const retained = store.database
      .prepare("SELECT * FROM history_replaced_facts WHERE fact_table='events'")
      .all()
      .find((row) => JSON.parse(row.payload).session_id === "session-1");
    assert.ok(retained, "deleted historical usage must remain recoverable");
    assert.deepEqual(JSON.parse(retained.payload), deleted);
    assert.equal(retained.occurrence_count, 1);
    await input.assertReference(store, [73, 22]);
    insertDatabaseEvent(writer, kind, 3, 29);
    await syncCount(store, 1, 4);
    await input.assertReference(store, [73, 22, 29]);
    assert.equal(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    assert.equal(statSync(`${input.filePath}-wal`).size, 0);
    await syncCount(store, 1, 5);
    await syncCount(store, 0, 5);
    revise(writer, kind, 81);
    assert.ok(statSync(`${input.filePath}-wal`).size > 0, "a real write must recreate WAL frames after truncation");
    assert.equal(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    assert.equal(statSync(`${input.filePath}-wal`).size, 0);
    await syncCount(store, 1, 6);
    await input.assertReference(store, [81, 22, 29]);
    writer.close();
    await syncCount(store, 0, 6);
    const before = facts(store);
    store.close();
    store = input.openStore();
    await syncCount(store, 0, 0);
    assert.deepEqual(facts(store), before);
  });

  test(`${kind}: commit inside repository resolution preserves the read snapshot and is caught by next sync`, async (t) => {
    const input = fixture(t, kind),
      store = input.openStore(),
      writer = input.writer();
    let committed = false;
    store.repositoryResolver = async (cwd) => {
      if (!committed) {
        committed = true;
        writer.exec("BEGIN");
        revise(writer, kind, 77);
        writer.exec(`UPDATE ${kind === "zcode" ? "session" : "session_v2"} SET directory='/fixture/revised'`);
        insertDatabaseEvent(writer, kind, 3, 31);
        writer.exec("COMMIT");
      }
      return repositoryResolver(cwd);
    };
    await syncCount(store, 1, 1);
    assert.equal(committed, true);
    assert.deepEqual(
      facts(store).map((row) => [row.session_id, row.project, row.output]),
      [
        ["session-0", "/fixture/project", 20],
        ["session-1", "/fixture/project", 21],
        ["session-2", "/fixture/project", 22],
      ],
      "the in-flight parse must publish one coherent pre-commit snapshot",
    );
    store.repositoryResolver = repositoryResolver;
    await syncCount(store, 1, 2);
    await input.assertReference(store, [77, 21, 22, 31]);
    assert.ok(
      facts(store)
        .filter((row) => row.session_id !== "session-3")
        .every((row) => row.project === "/fixture/revised"),
    );
    await syncCount(store, 0, 2);
  });
}
