import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { UsageStore } from "../src/usage-store.js";

for (const fail of [false, true])
  test(`source stat batches preserve order and partial failure: ${fail}`, async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "usage-discovery-batch-"));
    const sessions = path.join(root, "sessions");
    await fs.mkdir(sessions);
    const paths = Array.from({ length: 70 }, (_, index) =>
      path.join(sessions, `rollout-${String(index).padStart(3, "0")}.jsonl`),
    );
    await Promise.all(paths.map((file) => fs.writeFile(file, "{}\n")));
    const indexes = new Map(paths.map((file, index) => [file, index]));
    const stat = fs.stat;
    let active = 0,
      peak = 0;
    t.mock.method(fs, "stat", async (file, ...args) => {
      if (!indexes.has(file)) return stat(file, ...args);
      active++;
      peak = Math.max(active, peak);
      try {
        await setTimeout(indexes.get(file) === 0 ? 8 : 1);
        if (fail && indexes.get(file) === 2) throw new Error("fixture file 2 failed");
        return await stat(file, ...args);
      } finally {
        active--;
      }
    });
    syncBuiltinESMExports();
    const store = new UsageStore({ databaseFile: path.join(root, "unused.sqlite"), homeDir: root });
    try {
      const source = { id: "fixture", kind: "codex", path: root, label: "Fixture" };
      const result = await store.usageFiles([source]);
      assert.ok(peak > 1 && peak <= 32, `bounded active reads: ${peak}`);
      assert.equal(active, 0, "all pending reads settle before returning or reporting a failure");
      assert.deepEqual(
        result.files.map((row) => row.filePath),
        fail ? paths.slice(0, 2) : paths,
      );
      assert.ok(result.files.every((row) => row.source === source && row.info.size === 3));
      assert.deepEqual(result.failedHomes, fail ? [{ id: source.id, path: source.path }] : []);
      assert.deepEqual(result.warnings, fail ? [`无法读取 ${root}: fixture file 2 failed`] : []);
    } finally {
      store.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

function fingerprint(file) {
  const info = statSync(file),
    wal = statSync(`${file}-wal`, { throwIfNoEntry: false });
  const bytes = readFileSync(file),
    length = Math.min(bytes.length, 64 * 1024),
    hash = createHash("sha256");
  for (const offset of bytes.length > length ? [0, bytes.length - length] : [0])
    hash.update(bytes.subarray(offset, offset + length));
  return `${info.size + (wal?.size || 0)}:${Math.max(info.mtimeMs, wal?.size ? wal.mtimeMs : 0)}:${hash.digest("hex")}`;
}

for (const failure of ["none", "short read", "close"])
  test(`fingerprint batches preserve probe bytes, input order and handle bound: ${failure}`, async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "usage-fingerprint-batch-"));
    const paths = Array.from({ length: 70 }, (_, index) => path.join(root, `${index}.jsonl`));
    await Promise.all(
      paths.map((file, index) =>
        fs.writeFile(file, Buffer.alloc(index === 0 ? 0 : index === 1 ? 200_000 : 100, index)),
      ),
    );
    await fs.writeFile(`${paths[1]}-wal`, "wal");
    const expected = new Map(paths.map((file) => [file, fingerprint(file)]));
    const open = fs.open;
    let active = 0,
      peak = 0;
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args);
      active++;
      peak = Math.max(peak, active);
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      t.mock.method(handle, "read", async (buffer, offset, length, position) => {
        if (failure === "short read" && file === paths[2]) return { bytesRead: 0, buffer };
        return read(buffer, offset, Math.min(length, 8192), position);
      });
      t.mock.method(handle, "close", async () => {
        try {
          await setTimeout(file === paths[0] ? 8 : 1);
          await close();
          if (failure === "close" && [paths[0], paths[1]].includes(file)) throw new Error(`close ${file}`);
        } finally {
          active--;
        }
      });
      return handle;
    });
    syncBuiltinESMExports();
    const store = new UsageStore({ databaseFile: path.join(root, "unused.sqlite"), homeDir: root });
    try {
      const files = paths.map((filePath) => ({ filePath }));
      if (failure === "close") {
        await assert.rejects(store.usageFileFingerprints(files), { message: `close ${paths[0]}` });
      } else {
        if (failure === "short read") expected.set(paths[2], null);
        assert.deepEqual(await store.usageFileFingerprints(files), expected);
        assert.deepEqual(
          await store.usageFileFingerprints([{ filePath: path.join(root, "missing") }]),
          new Map([[path.join(root, "missing"), null]]),
        );
      }
      assert.ok(peak > 1 && peak <= 32, `bounded active handles: ${peak}`);
      assert.equal(active, 0, "every handle closes before a result or error is returned");
    } finally {
      store.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
