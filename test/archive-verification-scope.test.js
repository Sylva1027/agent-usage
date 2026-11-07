import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createHistoryArchiveCandidate,
  verifyHistoryArchiveCandidate,
  withVerifiedHistoryArchiveCandidate,
} from "../src/history-archive.js";
import {
  createHistoryBackup,
  createHistoryVerificationScope,
  hasHistoryVerificationScope,
  withVerifiedHistoryBackup,
} from "../src/history-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "archive-scope-"));
  const file = path.join(root, "candidate.sqlite"),
    manifestFile = path.join(root, "candidate.manifest.json");
  const source = new DatabaseSync(":memory:");
  try {
    source.exec(`
      PRAGMA user_version=19;
      CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE source_files(path TEXT PRIMARY KEY, kind TEXT, home_id TEXT, home_label TEXT, home_path TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY, source_path TEXT, timestamp_ms INTEGER, total INTEGER);
      CREATE TABLE rate_limit_observations(id INTEGER PRIMARY KEY);
      INSERT INTO source_files VALUES('/fixture/source','codex','h','Home','/fixture/home');
      INSERT INTO events VALUES(1,'/fixture/source',100,20);
    `);
    await createHistoryArchiveCandidate(source, file, { startMs: 0, endMs: 1000 });
  } finally {
    source.close();
  }
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, file, manifestFile, manifest: JSON.parse(fs.readFileSync(manifestFile, "utf8")) };
}

function observe(t, file) {
  const counts = { hashes: 0, bytes: 0, synchronousReads: 0, tables: 0, candidate: 0, quick: 0 };
  const open = fsPromises.open,
    openSync = fs.openSync,
    closeSync = fs.closeSync,
    readSync = fs.readSync,
    prepare = DatabaseSync.prototype.prepare;
  const databaseDescriptors = new Set();
  t.mock.method(fs, "openSync", (name, ...args) => {
    const descriptor = openSync(name, ...args);
    if (path.resolve(String(name)) === file) databaseDescriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    databaseDescriptors.delete(descriptor);
    return closeSync(descriptor);
  });
  t.mock.method(fsPromises, "open", async (name, ...args) => {
    const handle = await open(name, ...args);
    if (path.resolve(String(name)) === file) {
      counts.hashes++;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...readArgs) => {
        const result = await read(...readArgs);
        counts.bytes += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  t.mock.method(fs, "readSync", (...args) => {
    if (databaseDescriptors.has(args[0])) counts.synchronousReads++;
    return readSync(...args);
  });
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql, ...args) {
    if (/^SELECT \* FROM "/.test(sql)) counts.tables++;
    if (sql === "PRAGMA quick_check") counts.quick++;
    if (
      sql === "SELECT * FROM events ORDER BY id" ||
      sql.includes("SELECT sf.path") ||
      sql.includes("timestamp_ms < ? OR timestamp_ms >= ?")
    )
      counts.candidate++;
    return prepare.call(this, sql, ...args);
  });
  syncBuiltinESMExports();
  return counts;
}

// A tiny lease double exercises the scope contract; the native helper tests own OS write denial.
function leases() {
  const state = { opens: 0, closes: 0, checks: 0, valid: true };
  return Object.assign(state, {
    async pinFiles(paths) {
      assert.equal(paths.length, 2);
      state.opens++;
      return {
        async check() {
          state.checks++;
          return state.valid;
        },
        async close() {
          state.closes++;
        },
      };
    },
  });
}

async function evictMemoryProofs(file, manifestFile) {
  const original = fs.readFileSync(manifestFile),
    manifest = JSON.parse(original);
  try {
    for (let index = 0; index < 9; index++) {
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, programVersion: `evict-${index}` }));
      await verifyHistoryArchiveCandidate(file);
    }
  } finally {
    fs.writeFileSync(manifestFile, original);
  }
}

test("a leased scope singleflights both hashes and reuses the same pinned connection across runs", async (t) => {
  const { file, manifest } = await fixture(t),
    receipts = new Set(),
    pin = leases();
  const counts = observe(t, file),
    scope = createHistoryVerificationScope({ receipts, pinFiles: pin.pinFiles });
  let connection;
  const read = () =>
    withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
      if (connection) assert.strictEqual(database, connection);
      connection = database;
      const writer = new DatabaseSync(file);
      try {
        writer.exec("PRAGMA busy_timeout=0");
        assert.throws(
          () => writer.exec("UPDATE events SET total=21"),
          (error) => error.errcode === 5,
        );
      } finally {
        writer.close();
      }
      return database.prepare("SELECT total FROM events").get().total;
    });
  try {
    await scope.run(async () => {
      assert.equal(hasHistoryVerificationScope(), true);
      assert.deepEqual(await Promise.all([read(), read()]), [20, 20]);
    });
    assert.equal(hasHistoryVerificationScope(), false);
    assert.equal(await scope.run(read), 20);
    assert.equal(counts.hashes, 2);
    assert.equal(counts.bytes, manifest.database.bytes * 2);
    assert.equal(counts.synchronousReads, 0, "no hidden descriptor hashing");
    assert.equal(counts.tables, 4);
    assert.equal(counts.quick, 1);
    assert.equal(counts.candidate, 2, "range and source proof scan once; events share the backup scan");
    assert.equal(receipts.size, 2);
    assert.ok([...receipts].some((key) => key.startsWith("history-verification:backup:v1:path-locked-v2:")));
    assert.ok([...receipts].some((key) => key.startsWith("history-verification:candidate:v1:path-locked-v2:")));
    assert.equal(pin.opens, 1);
    assert.equal(pin.checks, 6);
    assert.equal(connection.isTransaction, true);
  } finally {
    await scope.close();
  }
  await scope.close();
  assert.equal(connection.isOpen, false);
  assert.equal(pin.closes, 1);
});

test("persistent path-locked receipts survive memory eviction; every reopened scope hashes fresh bytes", async (t) => {
  const { file, manifestFile, manifest } = await fixture(t),
    receipts = new Set();
  const initial = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
  try {
    await initial.run(() => verifyHistoryArchiveCandidate(file));
  } finally {
    await initial.close();
  }
  await evictMemoryProofs(file, manifestFile);
  assert.equal(receipts.size, 2);
  const counts = observe(t, file);
  let previous;
  for (let index = 0; index < 2; index++) {
    const scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
    try {
      await scope.run(() =>
        withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
          assert.notStrictEqual(database, previous);
          previous = database;
        }),
      );
    } finally {
      await scope.close();
    }
    assert.equal(previous.isOpen, false);
  }
  assert.equal(counts.hashes, 4);
  assert.equal(counts.bytes, manifest.database.bytes * 4);
  assert.equal(counts.synchronousReads, 0);
  assert.equal(counts.tables + counts.candidate + counts.quick, 0);
});

test("unleased DELETE verification never reads or writes persistent receipts", async (t) => {
  const { file, manifest } = await fixture(t),
    calls = { has: 0, add: 0 },
    counts = observe(t, file);
  const scope = createHistoryVerificationScope({
    pinFiles: async () => null,
    receipts: {
      has() {
        calls.has++;
        return true;
      },
      add() {
        calls.add++;
      },
    },
  });
  try {
    await scope.run(() => verifyHistoryArchiveCandidate(file));
    await scope.run(() => verifyHistoryArchiveCandidate(file));
    assert.deepEqual(calls, { has: 0, add: 0 });
    assert.equal(counts.tables, 4, "legacy process memory can reuse its own completed proof");
    assert.equal(counts.candidate, 2);
    assert.equal(counts.hashes, 4);
    assert.equal(counts.bytes, manifest.database.bytes * 4);
  } finally {
    await scope.close();
  }
});

test("legacy memory hits cannot upgrade to path-locked persistent proofs without full semantics", async (t) => {
  const { file } = await fixture(t);
  await verifyHistoryArchiveCandidate(file);
  await verifyHistoryArchiveCandidate(file);
  const receipts = new Set(),
    counts = observe(t, file);
  for (let index = 0; index < 2; index++) {
    const scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
    try {
      await scope.run(() => verifyHistoryArchiveCandidate(file));
    } finally {
      await scope.close();
    }
    assert.equal(counts.tables, 4, "the stronger proof must perform its own full scan exactly once");
    assert.equal(counts.candidate, 2);
    assert.equal(counts.quick, 1);
  }
  assert.equal(counts.hashes, 4);
  assert.equal(receipts.size, 2);
  assert.ok([...receipts].every((key) => key.includes(":path-locked-v2:")));
});

test("a later receipt receiver persists already-complete path-locked memory proofs", async (t) => {
  const { file } = await fixture(t);
  const initial = createHistoryVerificationScope({ pinFiles: leases().pinFiles });
  try {
    await initial.run(() => verifyHistoryArchiveCandidate(file));
  } finally {
    await initial.close();
  }
  const receipts = new Set(),
    counts = observe(t, file);
  const scope = createHistoryVerificationScope({
    pinFiles: leases().pinFiles,
    receipts: {
      has: (key) => receipts.has(key),
      add: (key) => {
        receipts.add(key);
      },
    },
  });
  try {
    await scope.run(() => verifyHistoryArchiveCandidate(file));
  } finally {
    await scope.close();
  }
  assert.equal(receipts.size, 2);
  assert.equal(counts.hashes, 2);
  assert.equal(counts.tables + counts.candidate + counts.quick, 0);
});

test("old algorithms, pre-v2 path proofs and changed full manifest bytes cannot consume a receipt", async (t) => {
  const { file, manifestFile } = await fixture(t),
    receipts = new Set();
  let scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
  await scope.run(() => verifyHistoryArchiveCandidate(file));
  await scope.close();
  assert.equal(receipts.size, 2);
  const counts = observe(t, file);
  for (const oldKeys of [
    [...receipts].map((key) => key.replace(":v1:", ":v0:")),
    [...receipts].map((key) => key.replace(":path-locked-v2:", ":path-locked-v1:")),
    [...receipts].map((key) => key.replace(":path-locked-v2:", ":")),
  ]) {
    await evictMemoryProofs(file, manifestFile);
    counts.tables = counts.candidate = counts.quick = 0;
    scope = createHistoryVerificationScope({ receipts: new Set(oldKeys), pinFiles: leases().pinFiles });
    try {
      await scope.run(() => verifyHistoryArchiveCandidate(file));
    } finally {
      await scope.close();
    }
    assert.equal(counts.tables, 4, "an obsolete receipt requires full backup semantics");
    assert.equal(counts.candidate, 2, "an obsolete candidate receipt cannot skip candidate semantics");
  }
  fs.appendFileSync(manifestFile, " \n");
  scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
  try {
    await scope.run(() => verifyHistoryArchiveCandidate(file));
  } finally {
    await scope.close();
  }
  assert.equal(counts.tables, 8, "whitespace is part of the full manifest digest");
});

test("fresh whole-byte hashes reject same-size, restored-mtime damage despite a completed receipt", async (t) => {
  const { file } = await fixture(t),
    receipts = new Set();
  const first = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
  await first.run(() => verifyHistoryArchiveCandidate(file));
  await first.close();
  const original = fs.statSync(file),
    bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, original.atime, original.mtime);
  const counts = observe(t, file),
    scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
  try {
    await assert.rejects(
      scope.run(() => verifyHistoryArchiveCandidate(file)),
      { code: "HISTORY_BACKUP_DIGEST_MISMATCH" },
    );
  } finally {
    await scope.close();
  }
  assert.equal(counts.hashes, 1);
  assert.equal(counts.tables + counts.candidate + counts.quick, 0);
});

test("lease loss catches raw writes even when all file metadata appears unchanged", async (t) => {
  const { file } = await fixture(t),
    pin = leases(),
    scope = createHistoryVerificationScope({ pinFiles: pin.pinFiles });
  let connection;
  await scope.run(() =>
    withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
      connection = database;
    }),
  );
  const stat = fs.statSync,
    fstat = fs.fstatSync,
    paths = new Map(),
    handles = new Map();
  t.mock.method(fs, "statSync", (name, options) => {
    const key = String(name);
    if (!paths.has(key)) paths.set(key, stat(name, options));
    return paths.get(key);
  });
  t.mock.method(fs, "fstatSync", (descriptor, options) => {
    if (!handles.has(descriptor)) handles.set(descriptor, fstat(descriptor, options));
    return handles.get(descriptor);
  });
  syncBuiltinESMExports();
  await scope.run(() => verifyHistoryArchiveCandidate(file));
  const original = stat(file),
    bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, original.atime, original.mtime);
  pin.valid = false;
  try {
    await assert.rejects(
      scope.run(() => verifyHistoryArchiveCandidate(file)),
      { code: "HISTORY_BACKUP_SCOPE_CHANGED" },
    );
  } finally {
    await scope.close();
  }
  assert.equal(connection.isOpen, false);
  assert.equal(pin.closes, 1);
});

test("manifest replacement and mutation after the synchronous reader reject and release", async (t) => {
  for (const mutation of ["replace", "reader"])
    await t.test(mutation, async (t) => {
      const { file, manifestFile } = await fixture(t),
        pin = leases(),
        receipts = new Set();
      const scope = createHistoryVerificationScope({ receipts, pinFiles: pin.pinFiles });
      let connection;
      if (mutation === "replace") {
        await scope.run(() =>
          withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
            connection = database;
          }),
        );
        fs.renameSync(manifestFile, `${manifestFile}.old`);
        fs.copyFileSync(`${manifestFile}.old`, manifestFile);
        await assert.rejects(
          scope.run(() => verifyHistoryArchiveCandidate(file)),
          { code: "HISTORY_BACKUP_SCOPE_CHANGED" },
        );
      } else {
        await assert.rejects(
          scope.run(() =>
            withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
              connection = database;
              const bytes = fs.readFileSync(file);
              bytes[bytes.length - 1] ^= 1;
              fs.writeFileSync(file, bytes);
              pin.valid = false;
            }),
          ),
          { code: "HISTORY_BACKUP_SCOPE_CHANGED" },
        );
        assert.equal(receipts.size, 0, "a failed post-read lease check cannot publish proofs");
      }
      await scope.close();
      assert.equal(connection.isOpen, false);
      assert.equal(pin.closes, 1);
    });
});

test("reader errors preserve completed proofs and release handles; async readers stay rejected", async (t) => {
  const { file } = await fixture(t),
    pin = leases(),
    receipts = new Set();
  const scope = createHistoryVerificationScope({ receipts, pinFiles: pin.pinFiles });
  let connection;
  const failure = new Error("reader failure");
  await assert.rejects(
    scope.run(() =>
      withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
        connection = database;
        throw failure;
      }),
    ),
    (error) => error === failure,
  );
  await scope.close();
  assert.equal(connection.isOpen, false);
  assert.equal(receipts.size, 2);
  for (const [read, code] of [
    [withVerifiedHistoryBackup, "HISTORY_BACKUP_READER_ASYNC"],
    [withVerifiedHistoryArchiveCandidate, "HISTORY_ARCHIVE_CANDIDATE_READER_ASYNC"],
  ]) {
    const next = createHistoryVerificationScope({ receipts, pinFiles: pin.pinFiles });
    try {
      await assert.rejects(
        next.run(() => read(file, undefined, () => Promise.resolve())),
        { code },
      );
    } finally {
      await next.close();
    }
  }
  assert.equal(pin.closes, 3);
});

test("failed candidate verification publishes only its independently completed backup proof", async (t) => {
  const { file, root } = await fixture(t),
    database = new DatabaseSync(file),
    receipts = new Set();
  try {
    const metadata = JSON.parse(
      database.prepare("SELECT value FROM store_meta WHERE key='history_archive_candidate'").get().value,
    );
    metadata.events.sha256 = "0".repeat(64);
    database
      .prepare("UPDATE store_meta SET value=? WHERE key='history_archive_candidate'")
      .run(JSON.stringify(metadata));
    const invalid = path.join(root, "invalid.sqlite");
    await createHistoryBackup(database, invalid);
    const scope = createHistoryVerificationScope({ receipts, pinFiles: leases().pinFiles });
    try {
      await assert.rejects(
        scope.run(() => verifyHistoryArchiveCandidate(invalid)),
        { code: "HISTORY_ARCHIVE_CANDIDATE_FINGERPRINT_MISMATCH" },
      );
    } finally {
      await scope.close();
    }
    assert.equal(receipts.size, 1);
    assert.ok([...receipts][0].startsWith("history-verification:backup:v1:"));
  } finally {
    database.close();
  }
});

test("WAL gets fresh connections, full hashes and semantic scans on every call", async (t) => {
  const { file, manifestFile, manifest } = await fixture(t),
    writer = new DatabaseSync(file),
    pin = leases(),
    receipts = new Set();
  const scope = createHistoryVerificationScope({ receipts, pinFiles: pin.pinFiles });
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    const { createHash } = await import("node:crypto");
    manifest.database.sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const counts = observe(t, file);
    await scope.run(() => verifyHistoryArchiveCandidate(file));
    assert.equal(pin.closes, 1);
    writer.exec("UPDATE events SET total=21");
    await assert.rejects(
      scope.run(() => verifyHistoryArchiveCandidate(file)),
      { code: "HISTORY_BACKUP_TABLE_MISMATCH" },
    );
    assert.equal(counts.hashes, 4);
    assert.equal(counts.tables, 8);
    assert.equal(receipts.size, 0);
    assert.equal(pin.closes, 2);
  } finally {
    await scope.close();
    writer.close();
  }
});

test("nested scopes isolate handles; close waits for active work and prevents future work", async (t) => {
  const { file } = await fixture(t),
    pin = leases();
  const outer = createHistoryVerificationScope({ pinFiles: pin.pinFiles }),
    inner = createHistoryVerificationScope({ pinFiles: pin.pinFiles });
  let outerDatabase, innerDatabase;
  await outer.run(async () => {
    await withVerifiedHistoryBackup(file, undefined, (database) => {
      outerDatabase = database;
    });
    await inner.run(() =>
      withVerifiedHistoryBackup(file, undefined, (database) => {
        innerDatabase = database;
      }),
    );
    assert.notStrictEqual(outerDatabase, innerDatabase);
    await inner.close();
    assert.equal(innerDatabase.isOpen, false);
    assert.equal(outerDatabase.isOpen, true);
    await outer.run(() =>
      withVerifiedHistoryBackup(file, undefined, (database) => assert.strictEqual(database, outerDatabase)),
    );
  });
  let release, started;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      started = resolve;
    });
  const active = outer.run(async () => {
    started();
    await waiting;
  });
  await entered;
  let closed = false;
  const closing = outer.close().then(() => {
    closed = true;
  });
  assert.throws(() => outer.run(() => {}), { code: "HISTORY_BACKUP_SCOPE_CLOSED" });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(outerDatabase.isOpen, true);
  release();
  await active;
  await closing;
  assert.equal(outerDatabase.isOpen, false);
  assert.equal(hasHistoryVerificationScope(), false);
  assert.equal(pin.closes, 2);
});
