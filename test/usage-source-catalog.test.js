import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageSourceAcquisition, ensureUsageSourceCatalog } from "../src/usage-source-acquisition.js";
import { createUsageSourceWatcher } from "../src/usage-source-watch.js";

function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const table of ["source_files", "usage_source_progress", "usage_source_reparse", "rate_limit_observations", "quota_usage_sources"])
    database.exec(`CREATE TABLE ${table}(value TEXT)`);
  ensureUsageSourceCatalog(database);
  const acquisition = new UsageSourceAcquisition({ database });
  const root = path.resolve("catalog-managed");
  const source = path.join(root, "source.jsonl");
  const object = { volume: "a", id64: "0000000000000001", id128: "01".repeat(16) };
  acquisition.put(source, object, "file", { seal: "10", supported: true });
  const cursor = { volume: "a", path: root, journalId: "1", nextUsn: "5" };
  const state = { scopes: [root.toLowerCase()], volumes: [cursor] };
  const record = { id: object.id64, parent: "0000000000000002", usn: "11", reason: 2 };
  const native = {
    changes: async () => ({ nextUsn: "20", records: [record], journalBytes: 88 }),
    resolve: async () => null,
  };
  return { database, acquisition, root, source, object, state, record, native };
}

test("catalog schema ensure is idempotent and repairing a dropped trigger revokes readiness", (t) => {
  const { database } = fixture(t);
  database.exec("INSERT INTO usage_source_catalog VALUES('','','','','state','{}',1)");
  const schema = database.prepare("PRAGMA schema_version").get().schema_version;
  ensureUsageSourceCatalog(database);
  assert.equal(database.prepare("PRAGMA schema_version").get().schema_version, schema);
  assert.equal(database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 1);
  database.exec("DROP TRIGGER usage_source_catalog_source_files_INSERT");
  ensureUsageSourceCatalog(database);
  assert.equal(database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 0);
});

test("catalog invalidation commits or rolls back with source progress and quota facts", (t) => {
  const { database } = fixture(t);
  database.exec("INSERT INTO usage_source_catalog VALUES('','','','','state','{}',1)");
  for (const table of ["source_files", "usage_source_progress", "usage_source_reparse", "rate_limit_observations", "quota_usage_sources"]) {
    database.exec(`BEGIN; INSERT INTO ${table} VALUES('change')`);
    assert.equal(database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 0);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 1);
  }
});

test("content seals skip covered data but never namespace flags or mixed CLOSE/data", async (t) => {
  const f = fixture(t);
  f.record.usn = "9";
  assert.deepEqual((await f.acquisition.interval(f.state, f.native)).dirty, []);
  f.record.reason = 0x2000;
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.record.reason = 0x80000002;
  f.record.usn = "11";
  assert.deepEqual((await f.acquisition.interval(f.state, f.native)).dirty, [f.source.toLowerCase()]);
  assert.equal((await f.acquisition.interval(f.state, f.native)).volumes[0].nextUsn, "20");
});

test("another harness, unknown managed path, missing parent and hardlink all refuse coverage", async (t) => {
  const f = fixture(t);
  f.acquisition.put(f.source, f.object, "file", { seal: "10", supported: false });
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.record.id = "0000000000000003";
  f.native.resolve = async () => ({ path: path.join(f.root, "new.jsonl"), links: 1, attributes: 0 });
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.native.resolve = async () => null;
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.record.reason = 0x10000;
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
});

test("unavailable or oversized journal fails closed; a deleted outside sibling is unrelated", async (t) => {
  const f = fixture(t);
  f.native.changes = async () => null;
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.native.changes = async () => ({ nextUsn: "20", records: Array(2049).fill(f.record), journalBytes: 1 });
  await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
  f.record.id = "0000000000000003";
  f.native.changes = async () => ({ nextUsn: "20", records: [f.record], journalBytes: 1 });
  f.native.resolve = async (_root, id) => id === f.record.parent ? { path: path.dirname(f.root), links: 1, attributes: 0 } : null;
  assert.deepEqual((await f.acquisition.interval(f.state, f.native)).dirty, []);
});

test("expired resolution budget refuses the interval without acknowledging its new cursor", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.native.changes = async () => { reads++; return { nextUsn: "20", records: [], journalBytes: 0 }; };
  let calls = 0;
  const clock = t.mock.method(performance, "now", () => calls++ === 0 ? 0 : 3000);
  try {
    await assert.rejects(f.acquisition.interval(f.state, f.native), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
    assert.equal(f.state.volumes[0].nextUsn, "5");
    assert.equal(reads, 0);
  } finally { clock.mock.restore(); }
});

test("watch hints retain paths, coalesce repeats and bound unknown/overflow without extending debounce", async () => {
  let listener, errorListener, scheduled;
  const received = [];
  const root = path.resolve("hint-root");
  const watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: root, recursive: true }],
    onHint: (hints) => received.push(hints),
    watchFile: (_root, _options, callback) => {
      listener = callback;
      return { on: (_name, callback) => { errorListener = callback; }, close() {} };
    },
    schedule: (callback) => { assert.equal(scheduled, undefined); scheduled = callback; return 1; },
    cancel() {},
  });
  try {
    await watcher.start();
    listener("change", "a");
    listener("change", "a");
    listener("rename", "b");
    listener("rename", null);
    const fire = scheduled; scheduled = undefined; fire();
    assert.equal(received[0].paths.length, 2);
    assert.equal(received[0].paths[0].path, path.join(root, "a"));
    assert.equal(received[0].paths[1].event, "rename");
    assert.equal(received[0].unknown, true);
    for (let i = 0; i < 200; i++) listener("change", String(i));
    const overflow = scheduled; scheduled = undefined; overflow();
    assert.equal(received[1].paths.length, 128);
    assert.equal(received[1].unknown, true);
    errorListener();
    const failed = scheduled; scheduled = undefined; failed();
    assert.equal(received[2].unknown, true);
  } finally { await watcher.stop(); }
});
