import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexProjectionCache } from "../src/perf-sources/codex-thread.js";
import { codexPlanningFingerprintAsync, planStableCodexHome, proveCodexLiveAppend } from "../src/usage-core.js";
import { createUsageExecutor } from "../src/usage-executor.js";

async function capture(files) {
  return codexPlanningFingerprintAsync({ kind: "codex" }, files);
}

test("planning prefix hashes raw bytes and reports unreadable inputs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-prefix-"));
  try {
    const files = [path.join(root, "one.jsonl"), path.join(root, "empty.jsonl")];
    writeFileSync(files[0], Buffer.concat([Buffer.alloc(200_000, 65), Buffer.from("\r\n末尾\n")]));
    writeFileSync(files[1], "");
    const window = await capture(files);
    assert.equal(window.complete, true);
    for (const file of files) {
      const bytes = readFileSync(file);
      assert.deepEqual(window.filePrefixEvidence[file], {
        size: bytes.length,
        digest: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const missing = path.join(root, "missing.jsonl");
    const failed = await capture([...files, missing]);
    assert.equal(failed.complete, false);
    assert.equal(Object.hasOwn(failed.filePrefixEvidence, missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large parallel planning preserves live isolation, quiet recovery, raw rewrite rejection and nested executor sync", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-prefix-large-"));
  try {
    const directory = path.join(root, "sessions");
    mkdirSync(directory);
    const files = ["active", "sibling"].map((id) => path.join(directory, `rollout-${id}.jsonl`));
    const padding = Buffer.alloc(64 * 1024, 32);
    padding[padding.length - 1] = 10;
    for (const [index, file] of files.entries()) {
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { id: `thread-${index}`, source: "cli" } })}\n`,
      );
      const handle = openSync(file, "a");
      try {
        for (let block = 0; block < 2048; block++) writeSync(handle, padding);
      } finally {
        closeSync(handle);
      }
    }
    const cache = createCodexProjectionCache();
    const home = { id: "codex", kind: "codex", path: root, projectionCache: cache, parallelPrefix: true };
    const first = await planStableCodexHome(home);
    assert.equal(first.ok, true, JSON.stringify(first));
    const lookup = cache.lookup.bind(cache);
    let injected = false;
    cache.lookup = (args) => {
      if (!injected) {
        injected = true;
        appendFileSync(
          files[0],
          `${JSON.stringify({ type: "turn_context", payload: { thread_id: "thread-0", turn_id: "new", model: "gpt-5" } })}\n`,
        );
      }
      return lookup(args);
    };
    const live = await planStableCodexHome(home);
    assert.equal(injected, true);
    assert.equal(live.ok, true);
    assert.equal(live.partial, true);
    assert.deepEqual(live.liveChangedThreadIds, ["thread-0"]);
    cache.lookup = lookup;
    const quiet = await planStableCodexHome(home);
    assert.equal(quiet.ok, true);
    assert.equal(quiet.partial ?? false, false);
    assert.equal(quiet.before.fingerprint, quiet.after.fingerprint);
    const handle = openSync(files[0], "r+");
    try {
      writeSync(handle, Buffer.from("X"), 0, 1, 100_000);
    } finally {
      closeSync(handle);
    }
    appendFileSync(files[0], "\n");
    const rewritten = await capture([files[0]]);
    assert.equal(
      await proveCodexLiveAppend(
        files[0],
        quiet.before.fileFingerprints[files[0]],
        rewritten.fileFingerprints[files[0]],
        "thread-0",
        quiet.before.filePrefixEvidence[files[0]],
      ),
      false,
    );
    // Restore the deliberate corruption before the real store parses this fixture.
    const restoreHandle = openSync(files[0], "r+");
    try {
      writeSync(restoreHandle, Buffer.from(" "), 0, 1, 100_000);
    } finally {
      closeSync(restoreHandle);
    }
    assert.ok(
      files.reduce((bytes, file) => bytes + statSync(file).size, 0) >= 256 * 1024 * 1024,
      "fixture must enter the two-reader async prefix branch",
    );
    const executor = createUsageExecutor({
      homeDir: root,
      env: {},
      extraHomes: root,
      automaticDiscoveryEnabled: false,
      importDirs: [],
      databaseFile: path.join(root, "index.sqlite"),
      pricingRefreshSchedulerEnabled: false,
    });
    try {
      const status = await executor.sync();
      assert.equal(status.perfState, "ready");
      assert.equal(status.updatedFileCount, files.length);
      assert.deepEqual(
        executor.homes.map((entry) => entry.path),
        [root],
      );
    } finally {
      await executor.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
