import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { compactRegisteredHistory } from "../src/history-archive-compaction.js";
import { clean, makeCompactionFixture } from "../test-support/history-compaction-fixture.mjs";

test("a disk-full flush never publishes an archive mapping or changes existing history", async (t) => {
  const f = await makeCompactionFixture(t);
  const expected = clean(await f.read());
  const registry = f.store.database.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all();
  const open = fs.open,
    failure = Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
  const mock = t.mock.method(fs, "open", async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (String(file).startsWith(f.directory + path.sep) && flags === "r+")
      handle.sync = async () => {
        throw failure;
      };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(compactRegisteredHistory(f.store, f.directory), (error) => error.code === "ENOSPC");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.stat(path.join(f.directory, "compaction.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all(), registry);
  assert.deepEqual(clean(await f.read()), expected);
});

test("explicit CLI switches an existing projection and rolls back while retaining later writes", async (t) => {
  const f = await makeCompactionFixture(t);
  const expected = clean(await f.read());
  f.store.close();
  const run = async (extra = []) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/cli.js", "history", "compact", f.file, f.directory, ...extra],
      { windowsHide: true },
    );
    return JSON.parse(stdout);
  };
  const forward = await run();
  assert.equal(forward.switched, 2);
  assert.equal(forward.projection.rebuilt, false);
  assert.equal(forward.projection.coldCopied, 0);
  await f.reopen();
  assert.deepEqual(clean(await f.read()), expected);
  f.append();
  f.reviseCold(9);
  const amended = clean(await f.read());
  f.store.close();
  const backward = await run(["--rollback"]);
  assert.equal(backward.switched, 2);
  assert.equal(backward.projection.rebuilt, false);
  await f.reopen();
  assert.deepEqual(clean(await f.read()), amended);
});

test("CLI rejects a missing source database without creating it", async (t) => {
  const f = await makeCompactionFixture(t);
  const missing = path.join(f.root, "missing-source.sqlite");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ["src/cli.js", "history", "compact", missing, path.join(f.root, "never-created")],
      { windowsHide: true },
    ),
  );
  await assert.rejects(fs.stat(missing), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.root, "never-created")), { code: "ENOENT" });
});
