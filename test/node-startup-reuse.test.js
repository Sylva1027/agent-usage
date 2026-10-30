import assert from "node:assert/strict";
import fs, { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexPlanningFingerprintAsync, perfHomeContentFingerprint } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function publishedFacts(store) {
  return Object.fromEntries(
    [
      ["events", "id"],
      ["perf_samples", "sample_key"],
      ["perf_rollout_threads", "source_path,home_id,thread_id"],
      ["perf_sample_sources", "sample_key,source_path,role"],
    ].map(([table, order]) => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]),
  );
}

function staged(store) {
  return [...store.codexThreadBuildPlan.values()].reduce((sum, plan) => sum + plan.staged.length, 0);
}

test("acknowledged missing Codex dependencies reuse candidates across restart, with return and content guards", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  let store = new UsageStore(fixture.serverOptions);
  const missingPath = fixture.rolloutFiles[1];
  const missingBytes = readFileSync(missingPath);
  const missingInfo = statSync(missingPath);
  try {
    await store.sync({ options: fixture.reportOptions });
    unlinkSync(missingPath);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(staged(store), 1, "a newly missing dependency must rebuild its thread once");
    const facts = publishedFacts(store);
    const missingSources = store.perfState().missingSources;
    const indexVersion = store.perfState().indexVersion;

    store.close();
    store = new UsageStore(fixture.serverOptions);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(staged(store), 0, "an acknowledged missing dependency must reuse the published candidate");
    assert.deepEqual(publishedFacts(store), facts);
    assert.deepEqual(store.perfState().missingSources, missingSources);
    assert.equal(store.perfState().indexVersion, indexVersion);

    const livePath = fixture.rolloutFiles[0];
    const liveText = readFileSync(livePath, "utf8");
    const liveInfo = statSync(livePath);
    const changedText = liveText.replace("codex-fixture-model", "codex-fixture-modeX");
    assert.notEqual(changedText, liveText);
    writeFileSync(livePath, changedText);
    utimesSync(livePath, liveInfo.atime, liveInfo.mtime);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(staged(store), 1, "same-size and same-mtime content changes must still rebuild");

    writeFileSync(livePath, liveText);
    utimesSync(livePath, liveInfo.atime, liveInfo.mtime);
    writeFileSync(missingPath, missingBytes);
    utimesSync(missingPath, missingInfo.atime, missingInfo.mtime);
    await store.sync({ options: fixture.reportOptions });
    assert.equal(staged(store), 1, "a returned dependency must rebuild its thread");
    assert.deepEqual(store.perfState().missingSources, []);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    fixture.close();
  }
});

test("prefix read failures keep fallback fingerprints without complete evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-startup-prefix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const middle = path.join(root, "middle.jsonl");
  const missing = path.join(root, "missing.jsonl");
  writeFileSync(middle, Buffer.alloc(400_000, 65));

  const realReadSync = fs.readSync;
  const realOpen = fsp.open;
  fs.readSync = function readSync(handle, buffer, offset, length, position) {
    if (position === 64 * 1024) throw new Error("unavailable prefix read");
    return realReadSync.call(this, handle, buffer, offset, length, position);
  };
  fsp.open = async function open(file, ...args) {
    const handle = await realOpen.call(this, file, ...args);
    if (file === middle) {
      handle.read = async () => {
        throw new Error("unavailable async prefix");
      };
    }
    return handle;
  };
  syncBuiltinESMExports();

  try {
    const files = [middle, missing];
    const syncResult = perfHomeContentFingerprint({ kind: "codex" }, files, null, true);
    const asyncResult = await codexPlanningFingerprintAsync({ kind: "codex" }, files);
    for (const result of [syncResult, asyncResult]) {
      assert.equal(result.complete, false);
      assert.equal(Object.hasOwn(result.filePrefixEvidence, middle), false);
      assert.equal(Object.hasOwn(result.filePrefixEvidence, missing), false);
      assert.equal(Object.hasOwn(result.fileFingerprints, missing), false);
    }
    assert.equal(typeof syncResult.fileFingerprints[middle], "string");
    assert.equal(typeof asyncResult.fileFingerprints[middle], "string");
  } finally {
    fs.readSync = realReadSync;
    fsp.open = realOpen;
    syncBuiltinESMExports();
  }
});
