import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildUsageFingerprint, discoverUsageSources } from "../src/usage-core.js";
import { UsageSourceProof, usageSourceIdentity } from "../src/usage-source-proof.js";
import { UsageStore } from "../src/usage-store.js";

const FIXED_MTIME_SECONDS = 1_793_686_800;
const PREFIX_SAMPLE_BYTES = 64 * 1024;

class ShaOnlySourceProof extends UsageSourceProof {
  async provider() {
    return null;
  }
}

class CountingRejectProof extends ShaOnlySourceProof {
  verifyCalls = 0;

  async verify() {
    this.verifyCalls += 1;
    return null;
  }
}

class CountingShaProof extends ShaOnlySourceProof {
  verifyCalls = 0;

  async verify(...args) {
    this.verifyCalls += 1;
    return super.verify(...args);
  }
}

function usage(total, cached = 0) {
  return {
    total_tokens: total,
    input_tokens: total,
    cached_input_tokens: cached,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function tokenRow(timestamp, cumulative, last) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(cumulative),
        last_token_usage: usage(last),
      },
    },
  };
}

function filler(index) {
  return {
    timestamp: "2026-11-03T01:01:01.000Z",
    type: "note",
    text: `${String(index).padStart(6, "0")}:${"x".repeat(64)}`,
  };
}

function codexLog(total) {
  /** @type {any[]} */
  const rows = [
    {
      timestamp: "2026-11-03T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "proof-adversarial",
        source: "cli",
        originator: "codex-tui",
        cwd: "/work/proof-adversarial",
        model_provider: "openai",
      },
    },
    { type: "turn_context", payload: { model: "gpt-5.1-codex" } },
  ];
  for (let index = 0; index < 5_000; index += 1) rows.push(filler(index));
  rows.push(tokenRow("2026-11-03T01:01:00.000Z", total, total));
  for (let index = 5_000; index < 10_000; index += 1) rows.push(filler(index));
  return `\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** @param {string} root */
function storeOptions(root) {
  return {
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    env: {},
    importDirs: [],
  };
}

/**
 * @param {any} options
 * @param {any} [proof]
 */
function createStore(options, proof) {
  const store = new UsageStore(options);
  store.repositoryResolver = (cwd) => /** @type {any} */ ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  if (proof) store.sourceProof = proof;
  return store;
}

async function makeFixture(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), `usage-proof-adversarial-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDirectory = path.join(root, ".codex", "sessions", "2026", "11", "03");
  await mkdir(sessionDirectory, { recursive: true });
  return {
    root,
    options: storeOptions(root),
    sourcePath: path.join(sessionDirectory, "rollout-proof-adversarial.jsonl"),
    replacementPath: path.join(sessionDirectory, "replacement.tmp"),
    oracleDatabaseFile: path.join(root, "oracle.sqlite"),
  };
}

function progressRow(store, sourcePath) {
  return store.database
    .prepare("SELECT source_binding,checkpoint_json,validation_json FROM usage_source_progress WHERE source_path=?")
    .get(sourcePath);
}

function factColumns(database, table, excluded = []) {
  const ignored = new Set(excluded);
  return database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .map((row) => String(row.name))
    .filter((column) => !ignored.has(column));
}

function tableRows(database, table, excluded = []) {
  const columns = factColumns(database, table, excluded);
  const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`);
  return database
    .prepare(`SELECT ${quoted.join(",")} FROM "${table}" ORDER BY ${quoted.join(",")}`)
    .all()
    .map((row) => ({ ...row }));
}

function factSnapshot(store) {
  return {
    events: tableRows(store.database, "events", ["id"]),
    rateLimitObservations: tableRows(store.database, "rate_limit_observations"),
    quotaUsageSources: tableRows(store.database, "quota_usage_sources"),
  };
}

async function exactInfo(filePath) {
  return stat(filePath, { bigint: true });
}

async function replaceWithSameMetadata(fixture, bytes) {
  await writeFile(fixture.replacementPath, bytes);
  await utimes(fixture.replacementPath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  await rename(fixture.replacementPath, fixture.sourcePath);
}

function assertSampleBytesEqual(before, after, changeAt) {
  assert.equal(before.length, after.length);
  assert.ok(changeAt >= PREFIX_SAMPLE_BYTES && changeAt < before.length - PREFIX_SAMPLE_BYTES);
  assert.deepEqual(before.subarray(0, PREFIX_SAMPLE_BYTES), after.subarray(0, PREFIX_SAMPLE_BYTES));
  assert.deepEqual(before.subarray(-PREFIX_SAMPLE_BYTES), after.subarray(-PREFIX_SAMPLE_BYTES));
}

test("progress-backed same-metadata replacement cannot take the unchanged fast path", async (t) => {
  const fixture = await makeFixture(t, "replacement");
  const oldText = codexLog(100);
  const newText = oldText.replaceAll('"total_tokens":100', '"total_tokens":900');
  const oldBytes = Buffer.from(oldText);
  const newBytes = Buffer.from(newText);
  const firstChange = oldBytes.indexOf(Buffer.from('"total_tokens":100'));
  assert.notEqual(firstChange, -1);
  assertSampleBytesEqual(oldBytes, newBytes, firstChange);

  await writeFile(fixture.sourcePath, oldBytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  const proof = new CountingRejectProof();
  const store = createStore(fixture.options, proof);
  try {
    await store.sync();
    assert.ok(progressRow(store, fixture.sourcePath), "the first parse must create a reusable checkpoint");

    const homes = await discoverUsageSources(fixture.options);
    const source = homes.find((candidate) => fixture.sourcePath.startsWith(candidate.path));
    assert.ok(source);
    const beforeFile = await exactInfo(fixture.sourcePath);
    const beforeFingerprint = await buildUsageFingerprint({
      ...fixture.options,
      homes,
      scannedFiles: [{ filePath: fixture.sourcePath, source, info: beforeFile }],
    });

    await replaceWithSameMetadata(fixture, newBytes);
    const afterFile = await exactInfo(fixture.sourcePath);
    assert.equal(afterFile.size, beforeFile.size);
    assert.equal(afterFile.mtimeNs, beforeFile.mtimeNs);
    assert.notEqual(afterFile.ino, beforeFile.ino);

    const afterFingerprint = await buildUsageFingerprint({
      ...fixture.options,
      homes,
      scannedFiles: [{ filePath: fixture.sourcePath, source, info: afterFile }],
    });
    assert.notEqual(
      afterFingerprint,
      beforeFingerprint,
      "the server-visible source fingerprint must include physical identity",
    );

    const result = await store.sync();
    assert.equal(result.updatedFileCount, 1);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 1);
    assert.ok(proof.verifyCalls > 0, "the store must reach proof verification instead of skipping the source");
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [900],
    );
    const saved = progressRow(store, fixture.sourcePath);
    assert.ok(saved);
    const validation = JSON.parse(saved.validation_json);
    assert.equal(typeof validation.identity, "string");
    assert.equal(validation.ctimeMs, (await stat(fixture.sourcePath)).ctimeMs);
  } finally {
    store.close();
  }
});
test("SHA prefix revision rolls back, survives restart, and repairs on the next sync", async (t) => {
  const fixture = await makeFixture(t, "sha-race");
  const oldText = codexLog(100);
  const changedText = oldText.replaceAll('"total_tokens":100', '"total_tokens":900');
  const oldBytes = Buffer.from(oldText);
  const changedBytes = Buffer.from(changedText);
  const firstChange = oldBytes.indexOf(Buffer.from('"total_tokens":100'));
  const secondChange = oldBytes.indexOf(Buffer.from('"total_tokens":100'), firstChange + 1);
  assert.ok(firstChange >= 0 && secondChange > firstChange);
  assertSampleBytesEqual(oldBytes, changedBytes, firstChange);

  class RacingShaProof extends ShaOnlySourceProof {
    mutateOnVerify = true;

    async verify(filePath, validation, offset, expectedInfo) {
      const verified = await super.verify(filePath, validation, offset, expectedInfo);
      assert.ok(verified);
      assert.equal(verified.nativeFence, null);
      if (!this.mutateOnVerify) return verified;
      this.mutateOnVerify = false;

      const handle = await open(filePath, "r+");
      try {
        await handle.write(Buffer.from("900"), 0, 3, firstChange + 15);
        await handle.write(Buffer.from("900"), 0, 3, secondChange + 15);
      } finally {
        await handle.close();
      }
      await utimes(filePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
      const current = await stat(filePath);
      assert.equal(current.size, expectedInfo.size);
      assert.equal(current.mtimeMs, expectedInfo.mtimeMs);

      // Keep the old digest but bind both observer snapshots to the post-mutation ctime.
      // This forces capture to detect the revision by rereading the certified prefix.
      expectedInfo.ctimeMs = current.ctimeMs;
      return { ...verified, info: current };
    }
  }

  await writeFile(fixture.sourcePath, oldBytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
  const racingProof = new RacingShaProof();
  let store = createStore(fixture.options, racingProof);
  let factsBefore;
  let progressBefore;
  let sourceBefore;
  let restoreProof;
  try {
    await store.sync();
    const rowsBefore = store.database.prepare("SELECT COUNT(*) AS count FROM events").get();
    assert.equal(Number(rowsBefore.count), 1);
    factsBefore = factSnapshot(store);
    progressBefore = progressRow(store, fixture.sourcePath);
    sourceBefore = store.database
      .prepare("SELECT size,mtime_ms FROM source_files WHERE path=?")
      .get(fixture.sourcePath);
    assert.ok(progressBefore);

    const suffix = `\n${JSON.stringify(tokenRow("2026-11-03T01:02:00.000Z", 950, 50))}\n`;
    const handle = await open(fixture.sourcePath, "a");
    try {
      await handle.writeFile(suffix);
    } finally {
      await handle.close();
    }
    await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

    await assert.rejects(store.sync(), (error) => {
      assert.equal(/** @type {any} */ (error).code, "LIVE_SOURCE_CHANGED");
      assert.match(/** @type {any} */ (error).message, /Certified prefix changed during suffix parsing/);
      return true;
    });
    assert.equal(racingProof.mutateOnVerify, false);
    assert.deepEqual(factSnapshot(store), factsBefore);
    assert.deepEqual(progressRow(store, fixture.sourcePath), progressBefore);
    assert.deepEqual(
      store.database.prepare("SELECT size,mtime_ms FROM source_files WHERE path=?").get(fixture.sourcePath),
      sourceBefore,
    );
    assert.equal(store.database.isTransaction, false);
    assert.equal(store.writeTransactionDepth, 0);
  } finally {
    store.close();
  }

  restoreProof = new ShaOnlySourceProof();
  store = createStore(fixture.options, restoreProof);
  try {
    const repaired = await store.sync();
    assert.equal(repaired.updatedFileCount, 1);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 1);
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms,id")
        .all()
        .map((row) => Number(row.total)),
      [900, 50],
    );

    const current = await exactInfo(fixture.sourcePath);
    const repairedProgress = progressRow(store, fixture.sourcePath);
    assert.ok(repairedProgress);
    const repairedValidation = JSON.parse(repairedProgress.validation_json);
    assert.equal(repairedValidation.ctimeMs, (await stat(fixture.sourcePath)).ctimeMs);
    assert.equal(typeof repairedValidation.identity, "string");
    assert.equal(JSON.parse(repairedProgress.checkpoint_json).offset, Number(current.size));

    const oracle = createStore({
      ...fixture.options,
      databaseFile: fixture.oracleDatabaseFile,
    });
    try {
      await oracle.sync();
      assert.deepEqual(factSnapshot(store), factSnapshot(oracle));
    } finally {
      oracle.close();
    }
  } finally {
    store.close();
    restoreProof.close();
  }
});

test("identical replacement recertifies a full SHA checkpoint without rewriting source facts", async (t) => {
  const fixture = await makeFixture(t, "identical-recertify");
  const text = codexLog(100);
  const bytes = Buffer.from(text);
  await writeFile(fixture.sourcePath, bytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

  const proof = new CountingShaProof();
  const store = createStore(fixture.options, proof);
  try {
    await store.sync();
    const beforeFile = await exactInfo(fixture.sourcePath);
    const beforeSource = store.database
      .prepare("SELECT size,mtime_ms,indexed_at FROM source_files WHERE path=?")
      .get(fixture.sourcePath);
    const beforeProgress = progressRow(store, fixture.sourcePath);
    assert.ok(beforeProgress);
    assert.equal(JSON.parse(beforeProgress.checkpoint_json).offset, Number(beforeFile.size));

    await replaceWithSameMetadata(fixture, bytes);
    const afterFile = await exactInfo(fixture.sourcePath);
    assert.equal(afterFile.size, beforeFile.size);
    assert.equal(afterFile.mtimeNs, beforeFile.mtimeNs);
    assert.notEqual(afterFile.ino, beforeFile.ino);

    const result = await store.sync();
    assert.equal(result.updatedFileCount, 0);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 0);
    assert.equal(proof.verifyCalls, 1);
    assert.ok(
      store.lastSyncSourceWork.prefixBytesRead >= Number(afterFile.size) * 2,
      "recertification must read the complete prefix once for verify and once for capture",
    );

    assert.deepEqual(
      store.database.prepare("SELECT size,mtime_ms,indexed_at FROM source_files WHERE path=?").get(fixture.sourcePath),
      beforeSource,
    );
    const afterProgress = progressRow(store, fixture.sourcePath);
    assert.ok(afterProgress);
    assert.deepEqual(JSON.parse(afterProgress.checkpoint_json), JSON.parse(beforeProgress.checkpoint_json));
    const validation = JSON.parse(afterProgress.validation_json);
    assert.equal(validation.identity, usageSourceIdentity(await stat(fixture.sourcePath)));
    assert.equal(validation.ctimeMs, (await stat(fixture.sourcePath)).ctimeMs);
  } finally {
    store.close();
  }
});

test("identical recovery after a missing sync preserves facts and indexed_at", async (t) => {
  const fixture = await makeFixture(t, "missing-identical-recovery");
  const bytes = Buffer.from(codexLog(100));
  await writeFile(fixture.sourcePath, bytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

  const proof = new CountingShaProof();
  const store = createStore(fixture.options, proof);
  try {
    await store.sync();
    const originalFile = await exactInfo(fixture.sourcePath);
    const originalFacts = factSnapshot(store);
    const originalSource = store.database
      .prepare("SELECT size,mtime_ms,indexed_at FROM source_files WHERE path=?")
      .get(fixture.sourcePath);
    const originalProgress = progressRow(store, fixture.sourcePath);
    assert.ok(originalProgress);

    await rm(fixture.sourcePath);
    await store.sync();
    assert.deepEqual(factSnapshot(store), originalFacts);
    assert.deepEqual(
      store.database.prepare("SELECT size,mtime_ms,indexed_at FROM source_files WHERE path=?").get(fixture.sourcePath),
      originalSource,
    );

    await writeFile(fixture.sourcePath, bytes);
    await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
    const restoredFile = await exactInfo(fixture.sourcePath);
    assert.equal(restoredFile.size, originalFile.size);
    assert.equal(restoredFile.mtimeNs, originalFile.mtimeNs);
    assert.notEqual(restoredFile.ino, originalFile.ino);

    const result = await store.sync();
    assert.equal(result.updatedFileCount, 0);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 0);
    assert.equal(proof.verifyCalls, 1);
    assert.ok(store.lastSyncSourceWork.prefixBytesRead >= Number(restoredFile.size) * 2);
    assert.deepEqual(factSnapshot(store), originalFacts);
    assert.deepEqual(
      store.database.prepare("SELECT size,mtime_ms,indexed_at FROM source_files WHERE path=?").get(fixture.sourcePath),
      originalSource,
    );
    const restoredProgress = progressRow(store, fixture.sourcePath);
    assert.ok(restoredProgress);
    assert.deepEqual(JSON.parse(restoredProgress.checkpoint_json), JSON.parse(originalProgress.checkpoint_json));
    assert.equal(
      JSON.parse(restoredProgress.validation_json).identity,
      usageSourceIdentity(await stat(fixture.sourcePath)),
    );
  } finally {
    store.close();
  }
});

test("a partial checkpoint is never rebound to a replacement inode", async (t) => {
  const fixture = await makeFixture(t, "partial-recertify");
  const complete = Buffer.from(codexLog(100));
  const partial = Buffer.from('{"partial":');
  const bytes = Buffer.concat([complete, partial]);
  await writeFile(fixture.sourcePath, bytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

  const proof = new CountingShaProof();
  const store = createStore(fixture.options, proof);
  try {
    await store.sync();
    const beforeFile = await exactInfo(fixture.sourcePath);
    const beforeProgress = progressRow(store, fixture.sourcePath);
    assert.ok(beforeProgress);
    const beforeCheckpoint = JSON.parse(beforeProgress.checkpoint_json);
    assert.ok(beforeCheckpoint.offset < Number(beforeFile.size));

    await replaceWithSameMetadata(fixture, bytes);
    const afterFile = await exactInfo(fixture.sourcePath);
    assert.equal(afterFile.size, beforeFile.size);
    assert.equal(afterFile.mtimeNs, beforeFile.mtimeNs);
    assert.notEqual(afterFile.ino, beforeFile.ino);

    const result = await store.sync();
    assert.equal(result.updatedFileCount, 1);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 1);
    assert.ok(proof.verifyCalls > 0, "changed physical identity must not enter the no-read fast path");
    const afterProgress = progressRow(store, fixture.sourcePath);
    assert.ok(afterProgress);
    assert.equal(JSON.parse(afterProgress.checkpoint_json).offset, beforeCheckpoint.offset);
    assert.ok(JSON.parse(afterProgress.checkpoint_json).offset < Number(afterFile.size));
    assert.equal(
      JSON.parse(afterProgress.validation_json).identity,
      usageSourceIdentity(await stat(fixture.sourcePath)),
    );
  } finally {
    store.close();
  }
});

test("a dirty transition during recertification invalidates the saved checkpoint before rebinding", async (t) => {
  const fixture = await makeFixture(t, "dirty-recertify");
  const bytes = Buffer.from(codexLog(100));
  await writeFile(fixture.sourcePath, bytes);
  await utimes(fixture.sourcePath, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

  class DirtyingShaProof extends CountingShaProof {
    dirtyInjected = false;

    async verify(filePath, validation, offset, info) {
      const verified = await super.verify(filePath, validation, offset, info);
      if (verified && !this.dirtyInjected) {
        this.dirtyInjected = true;
        const database = new DatabaseSync(fixture.options.databaseFile);
        try {
          database.exec("BEGIN IMMEDIATE");
          database.prepare("INSERT OR IGNORE INTO usage_source_reparse(source_path) VALUES(?)").run(filePath);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          database.close();
        }
      }
      return verified;
    }
  }

  const proof = new DirtyingShaProof();
  const store = createStore(fixture.options, proof);
  try {
    await store.sync();
    await replaceWithSameMetadata(fixture, bytes);

    const result = await store.sync();
    assert.equal(proof.dirtyInjected, true);
    assert.equal(result.updatedFileCount, 1);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 1);
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS count FROM usage_source_reparse").get().count), 0);
    assert.ok(progressRow(store, fixture.sourcePath));
  } finally {
    store.close();
  }
});
