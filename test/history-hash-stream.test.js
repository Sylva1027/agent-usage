import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";

const CHUNK_BYTES = 1024 * 1024;

for (const readLimit of [CHUNK_BYTES, 65537]) {
  test(`backup hashes alternate two 1 MiB buffers through EOF with ${readLimit}-byte reads`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "history-hash-stream-"));
    const source = new DatabaseSync(":memory:");
    const open = fsPromises.open;
    const reads = [];
    const readError = Object.assign(new Error("injected hash read failure"), { code: "EIO" });
    let failRead = false;
    t.mock.method(fsPromises, "open", async (file, flags) => {
      assert.equal(flags, "r");
      const handle = await open(file, flags);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      const record = { buffers: [], bytesRead: 0, count: 0, closeCount: 0, eof: false };
      reads.push(record);
      t.mock.method(handle, "read", async (buffer, offset, length, position) => {
        assert.ok(Buffer.isBuffer(buffer));
        assert.equal(buffer.length, CHUNK_BYTES);
        const index = record.count % 2;
        record.buffers[index] ??= buffer;
        assert.strictEqual(buffer, record.buffers[index], "each hash alternates two reused buffers, including EOF");
        if (record.buffers.length === 2) assert.notStrictEqual(record.buffers[0], record.buffers[1]);
        assert.equal(offset, 0);
        assert.equal(position, null);
        assert.ok(length > 0 && length <= CHUNK_BYTES);
        record.count++;
        if (failRead && record.count === 2) throw readError;
        const result = await read(buffer, offset, Math.min(length, readLimit), position);
        record.bytesRead += result.bytesRead;
        record.eof = result.bytesRead === 0;
        return result;
      });
      t.mock.method(handle, "close", async () => {
        record.closeCount++;
        await close();
      });
      return handle;
    });
    const assertReads = (records, bytes) => {
      for (const record of records) {
        assert.equal(record.bytesRead, bytes);
        assert.equal(record.count, Math.ceil(bytes / readLimit) + 1);
        assert.equal(record.eof, true);
        assert.equal(record.closeCount, 1);
      }
    };
    syncBuiltinESMExports();
    try {
      source.exec(`
      PRAGMA user_version = 19;
      CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE source_files (path TEXT PRIMARY KEY);
      CREATE TABLE events (id INTEGER PRIMARY KEY);
      CREATE TABLE rate_limit_observations (id INTEGER PRIMARY KEY);
      CREATE TABLE padding (data BLOB);
      INSERT INTO padding VALUES (zeroblob(${2 * 1024 * 1024 + 137}));
    `);
      const file = path.join(root, "history.sqlite");
      const manifestFile = path.join(root, "history.manifest.json");
      const manifest = await createHistoryBackup(source, file);
      const original = fs.readFileSync(file);
      assert.ok(original.length > 2 * 1024 * 1024);
      assert.equal(manifest.database.bytes, original.length);
      assert.equal(manifest.database.sha256, createHash("sha256").update(original).digest("hex"));
      assert.equal(reads.length, 1);
      assertReads(reads, original.length);
      assert.equal((await verifyHistoryBackup(file)).ok, true);
      assert.equal(reads.length, 3, "verification hashes before and under the pinned SQLite snapshot");
      assertReads(reads, original.length);

      const restored = path.join(root, "restored.sqlite");
      await restoreHistoryBackup(file, restored);
      assert.deepEqual(fs.readFileSync(restored), original);
      assert.equal(reads.length, 6, "restore retains both source hashes and the copied-file hash");
      assertReads(reads, original.length);

      const withTail = Buffer.concat([original, Buffer.from([0, 255, 137, 42, 1, 128, 99])]);
      fs.writeFileSync(file, withTail);
      manifest.database.bytes = withTail.length;
      manifest.database.sha256 = createHash("sha256").update(withTail).digest("hex");
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.notEqual(withTail.length % (1024 * 1024), 0);
      assert.equal((await verifyHistoryBackup(file)).ok, true);
      assert.equal(reads.length, 8);
      assertReads(reads.slice(-2), withTail.length);

      failRead = true;
      await assert.rejects(verifyHistoryBackup(file), (error) => error === readError);
      failRead = false;
      assert.equal(reads.length, 9);
      assert.equal(reads.at(-1).bytesRead, readLimit);
      assert.equal(reads.at(-1).count, 2);
      assert.equal(reads.at(-1).eof, false);
      assert.equal(reads.at(-1).closeCount, 1, "read failures close the hash handle before rejecting");

      withTail[withTail.length - 1] ^= 1;
      fs.writeFileSync(file, withTail);
      await assert.rejects(verifyHistoryBackup(file), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
      assert.equal(reads.length, 10);
      assertReads(reads.slice(-1), withTail.length);
      fs.unlinkSync(file);
      await assert.rejects(verifyHistoryBackup(file), { code: "ENOENT" });
      assert.equal(reads.length, 10, "failed opens do not leave a hash handle");
      assert.ok(reads.every((record) => record.closeCount === 1));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      source.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
