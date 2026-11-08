import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { compactRegisteredHistory, switchHistoryArchivePackages } from "../src/history-archive-compaction.js";
import { verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { createHistoryVerificationScope } from "../src/history-backup.js";
import { createStoredQuotaSourceResolver } from "../src/usage-quota-source-store.js";
import { clean, DAY, makeCompactionFixture, START } from "../test-support/history-compaction-fixture.mjs";

const registry = (store) =>
  clean(store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all());
const manifestFile = (file) => path.join(path.dirname(file), `${path.parse(file).name}.manifest.json`);
const projection = (store) => {
  const database = store.historyProjectionStore.query.database;
  return {
    facts: database.prepare("SELECT * FROM events ORDER BY id").all(),
    raw: database.prepare("SELECT rowid,payload,event_id FROM history_query_rows ORDER BY rowid").all(),
    checkpoints: database
      .prepare("SELECT * FROM usage_history_all_summary_checkpoints ORDER BY timestamp_ms,event_id")
      .all(),
    summary: database.prepare("SELECT * FROM usage_history_all_summary_state").all(),
    quota: database.prepare("SELECT rowid,* FROM quota_usage_sources ORDER BY rowid").all(),
  };
};
function assertNoColdCopy(work) {
  assert.equal(work.coldCopied, 0);
  assert.equal(work.rebuilt, false);
}

test("compaction preserves existing facts, exact all-summary checkpoints and quota rowids; rollback retains later writes", async (t) => {
  const f = await makeCompactionFixture(t);
  f.reviseCold(3);
  const before = clean(await f.read());
  const facts = projection(f.store);
  const old = registry(f.store);
  assert.equal(before.summary.eventCount, 6);
  assert.equal(before.summary.sessionCount, 2);
  assert.ok(before.summary.costEstimate.totalUsd > 0);
  assert.ok(facts.checkpoints.length > 0);
  assert.deepEqual(
    facts.quota.map((row) => row.rowid),
    [-7, 91],
  );
  assert.deepEqual(before, clean(await f.oracle()));

  const result = await compactRegisteredHistory(f.store, f.directory);
  assert.equal(result.switched, 2);
  assertNoColdCopy(result.projection);
  const mapping = JSON.parse(readFileSync(result.mappingFile, "utf8"));
  assert.equal(mapping.packages.length, 2);
  assert.deepEqual(
    registry(f.store),
    mapping.packages.map((entry) => entry.next),
  );
  for (const { previous, next } of mapping.packages) {
    assert.equal(existsSync(previous.database_path), true);
    assert.ok(statSync(next.database_path).size < statSync(previous.database_path).size);
    const a = await verifyHistoryArchiveCandidate(previous.database_path);
    const b = await verifyHistoryArchiveCandidate(next.database_path);
    assert.deepEqual(b.manifest.pricing, a.manifest.pricing);
    assert.deepEqual(b.manifest.serviceTierEvidence, a.manifest.serviceTierEvidence);
    const database = new DatabaseSync(next.database_path, { readOnly: true });
    try {
      assert.deepEqual(
        database
          .prepare("SELECT rowid FROM quota_usage_sources ORDER BY rowid")
          .all()
          .map((row) => row.rowid),
        [-7, 91],
      );
      assert.equal(createStoredQuotaSourceResolver(database, null)("home", "cross-session", START + 1000), "credits");
    } finally {
      database.close();
    }
  }
  assert.deepEqual(projection(f.store), facts);
  assert.deepEqual(clean(await f.read()), before);
  assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
  assert.equal(f.store.lastHistoryQueryWork.views.all.readEvents, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.all.pricedEvents, 0);
  await f.reopen();
  assert.deepEqual(clean(await f.read()), before);
  assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
  assert.deepEqual(projection(f.store), facts);
  const replay = await compactRegisteredHistory(f.store, f.directory);
  assert.equal(replay.switched, 0);
  assert.equal(replay.replay, true);

  f.append();
  f.reviseCold(11);
  const current = clean(await f.read());
  const updated = projection(f.store);
  assert.equal(current.summary.eventCount, 7);
  assert.notEqual(current.summary.costEstimate.totalUsd, before.summary.costEstimate.totalUsd);
  assert.deepEqual(current, clean(await f.oracle()));
  const rolledBack = await compactRegisteredHistory(f.store, f.directory, { rollback: true });
  assert.equal(rolledBack.switched, 2);
  assertNoColdCopy(rolledBack.projection);
  assert.deepEqual(registry(f.store), old);
  assert.deepEqual(clean(await f.read()), current);
  assert.deepEqual(projection(f.store), updated);
  assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
  const revisions = JSON.parse(f.store.readMetaRaw("history_archive_event_revisions")).revisions;
  assert.equal(revisions[0].segmentId, old[0].segment_id);
  assert.equal(revisions[0].databaseSha256, old[0].database_sha256);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  assert.equal(existsSync(f.sourcePath), false);
  assert.equal((await compactRegisteredHistory(f.store, f.directory, { rollback: true })).replay, true);
  await f.reopen();
  assert.deepEqual(clean(await f.read()), current);
  assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
});

test("saved mappings resume after errors before and after the primary commit without rebuilding cold facts", async (t) => {
  for (const afterCommit of [false, true])
    await t.test(afterCommit ? "after commit" : "before commit", async (child) => {
      const f = await makeCompactionFixture(child);
      const expected = clean(await f.read());
      const facts = projection(f.store);
      const old = registry(f.store);
      const rebind = f.store.rebindHistoryArchiveReferences;
      const failure = new Error(`interrupted ${afterCommit ? "after" : "before"} primary commit`);
      const mock = child.mock.method(f.store, "rebindHistoryArchiveReferences", function (...args) {
        if (afterCommit) rebind.apply(this, args);
        throw failure;
      });
      await assert.rejects(compactRegisteredHistory(f.store, f.directory), (error) => error === failure);
      const mapping = JSON.parse(readFileSync(path.join(f.directory, "compaction.json"), "utf8"));
      assert.deepEqual(registry(f.store), afterCommit ? mapping.packages.map((entry) => entry.next) : old);
      assert.deepEqual(projection(f.store), facts);
      mock.mock.restore();
      await f.reopen();
      const resumed = await compactRegisteredHistory(f.store, f.directory);
      assert.equal(resumed.switched, afterCommit ? 0 : 2);
      assertNoColdCopy(resumed.projection);
      assert.deepEqual(clean(await f.read()), expected);
      assert.deepEqual(projection(f.store), facts);
      assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
      assert.equal((await compactRegisteredHistory(f.store, f.directory)).replay, true);
    });
});

test("maintenance guards reject external unrelated writes and appends without overwriting either", async (t) => {
  const f = await makeCompactionFixture(t);
  await f.read();
  const mapping = await f.prepareMapping();
  const old = registry(f.store);
  const external = new DatabaseSync(f.file);
  try {
    for (const append of [false, true]) {
      const guard = f.store.captureArchiveMaintenanceGuard();
      if (append) f.append(START + 4 * DAY, 17, external);
      else external.prepare("INSERT INTO unrelated VALUES(?)").run("external write survives");
      await assert.rejects(
        switchHistoryArchivePackages(f.store, mapping, { guard }),
        (error) => error.code === "HISTORY_ARCHIVE_COMPACTION_CHANGED",
      );
      assert.deepEqual(registry(f.store), old);
      assert.equal(f.store.database.prepare("SELECT value FROM unrelated").get().value, "external write survives");
      assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, append ? 2 : 1);
    }
  } finally {
    external.close();
  }
  assert.deepEqual(clean(await f.read()), clean(await f.oracle()));
  const result = await switchHistoryArchivePackages(f.store, mapping);
  assert.equal(result.switched, 2);
  assertNoColdCopy(result.projection);
  assert.equal((await f.read()).summary.eventCount, 7);
});

test("tampered package bytes, stale manifests and mappings for another database are rejected atomically", async (t) => {
  const f = await makeCompactionFixture(t);
  const expected = clean(await f.read());
  const mapping = await f.prepareMapping();
  const old = registry(f.store);
  await assert.rejects(
    switchHistoryArchivePackages(f.store, { ...mapping, databaseFile: path.join(f.root, "other.sqlite") }),
    /another primary database/,
  );
  assert.deepEqual(registry(f.store), old);
  const { previous, next } = mapping.packages[1];
  const bytes = readFileSync(next.database_path);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  writeFileSync(next.database_path, changed);
  await assert.rejects(
    switchHistoryArchivePackages(f.store, mapping),
    (error) => error.code === "HISTORY_BACKUP_DIGEST_MISMATCH",
  );
  assert.deepEqual(registry(f.store), old);
  writeFileSync(next.database_path, bytes);
  const manifest = manifestFile(next.database_path);
  const validManifest = readFileSync(manifest);
  const stale = JSON.parse(readFileSync(manifestFile(previous.database_path), "utf8"));
  stale.database.filename = path.basename(next.database_path);
  writeFileSync(manifest, JSON.stringify(stale));
  await assert.rejects(switchHistoryArchivePackages(f.store, mapping), (error) =>
    /^HISTORY_BACKUP_(SIZE|DIGEST)_MISMATCH$/.test(error.code),
  );
  assert.deepEqual(registry(f.store), old);
  writeFileSync(manifest, validManifest);
  assert.deepEqual(clean(await f.read()), expected);
  assert.equal((await switchHistoryArchivePackages(f.store, mapping)).switched, 2);
  assert.deepEqual(clean(await f.read()), expected);
  assertNoColdCopy(f.store.lastHistoryQueryWork.projection);
});

test("compaction requires leases even inside an existing weak verification scope", async (t) => {
  const f = await makeCompactionFixture(t);
  const expected = clean(await f.read());
  const mapping = await f.prepareMapping();
  const old = registry(f.store);
  const rebind = t.mock.method(f.store, "rebindHistoryArchiveReferences");
  const createScope = t.mock.method(f.store, "createHistoryVerificationScope", async (options) => {
    assert.equal(options.requireLeases, true);
    return createHistoryVerificationScope({ requireLeases: true });
  });
  const weak = createHistoryVerificationScope();
  try {
    await assert.rejects(
      weak.run(() => switchHistoryArchivePackages(f.store, mapping)),
      (error) => error.code === "HISTORY_BACKUP_LEASE_REQUIRED",
    );
  } finally {
    await weak.close();
    createScope.mock.restore();
  }
  assert.equal(createScope.mock.callCount(), 1);
  assert.equal(rebind.mock.callCount(), 0);
  assert.deepEqual(registry(f.store), old);
  assert.deepEqual(clean(await f.read()), expected);
});

test("compaction rechecks earlier package leases and bytes before the primary commit", async (t) => {
  for (const fault of ["lost lease", "changed bytes"])
    await t.test(fault, async (child) => {
      const f = await makeCompactionFixture(child);
      const expected = clean(await f.read());
      const mapping = await f.prepareMapping();
      const old = registry(f.store);
      const rebind = child.mock.method(f.store, "rebindHistoryArchiveReferences");
      const leases = new Map();
      let injected = false;
      const createScope = child.mock.method(f.store, "createHistoryVerificationScope", async (options) => {
        assert.equal(options.requireLeases, true);
        return createHistoryVerificationScope({
          requireLeases: true,
          // These leases inject failure states; they do not certify native file locking.
          pinFiles: async ([file]) => {
            if (file === mapping.packages[1].previous.database_path) {
              const firstTarget = mapping.packages[0].next.database_path;
              assert.equal(leases.get(firstTarget).closed, false);
              if (fault === "lost lease") leases.get(firstTarget).valid = false;
              else {
                const bytes = readFileSync(firstTarget);
                bytes[bytes.length - 1] ^= 1;
                writeFileSync(firstTarget, bytes);
              }
              injected = true;
            }
            const state = { valid: true, closed: false };
            leases.set(file, state);
            return {
              async check() {
                return state.valid && !state.closed;
              },
              async close() {
                state.closed = true;
              },
            };
          },
        });
      });
      await assert.rejects(
        switchHistoryArchivePackages(f.store, mapping),
        (error) => error.code === "HISTORY_BACKUP_SCOPE_CHANGED",
      );
      createScope.mock.restore();
      assert.equal(injected, true);
      assert.equal(leases.size, 4, "the first target changes only after its verification; all later packages verify");
      assert.ok([...leases.values()].every((lease) => lease.closed));
      assert.equal(rebind.mock.callCount(), 0);
      assert.deepEqual(registry(f.store), old);
      assert.deepEqual(clean(await f.read()), expected);
    });
});

test("compaction rejects a valid WAL package and releases actual native leases without switching", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await makeCompactionFixture(t);
  const expected = clean(await f.read());
  const mapping = await f.prepareMapping();
  const old = registry(f.store);
  const target = mapping.packages[0].next;
  const database = new DatabaseSync(target.database_path);
  try {
    assert.equal(database.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
  } finally {
    database.close();
  }
  // The WAL fixture has a valid new byte identity; this is a maintenance-mode rejection, not stale-manifest rejection.
  const bytes = readFileSync(target.database_path);
  const manifest = JSON.parse(readFileSync(manifestFile(target.database_path), "utf8"));
  manifest.database.sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.database.bytes = bytes.length;
  writeFileSync(manifestFile(target.database_path), JSON.stringify(manifest));
  target.segment_id = target.database_sha256 = manifest.database.sha256;
  assert.equal((await verifyHistoryArchiveCandidate(target.database_path)).ok, true);

  const native = await f.store.sourceProof.provider();
  assert.ok(native, "the Windows fixture must discover the actual native provider");
  const lockFiles = native.lockFiles;
  const acquired = [];
  const locks = t.mock.method(native, "lockFiles", async function (files) {
    const lease = await lockFiles.call(this, files);
    assert.ok(lease, "this regression requires actual file leases");
    const state = { files, lease, closed: false };
    acquired.push(state);
    return {
      check: () => lease.check(),
      async close() {
        await lease.close();
        state.closed = true;
      },
    };
  });
  const rebind = t.mock.method(f.store, "rebindHistoryArchiveReferences");
  await assert.rejects(
    switchHistoryArchivePackages(f.store, mapping),
    (error) => error.code === "HISTORY_BACKUP_MAINTENANCE_MODE",
  );
  locks.mock.restore();
  assert.deepEqual(
    acquired.map(({ files }) => files[0]),
    [mapping.packages[0].previous.database_path, target.database_path],
  );
  assert.ok(acquired.every(({ closed }) => closed));
  for (const { lease, files } of acquired) {
    assert.equal(await lease.check(), false);
    for (const file of files) closeSync(openSync(file, "r+"));
  }
  assert.equal(rebind.mock.callCount(), 0);
  assert.deepEqual(registry(f.store), old);
  assert.deepEqual(clean(await f.read()), expected);
});
