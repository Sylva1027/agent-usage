import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import fsp from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";

import {CONTENT_ANCHORS, rebuildContentSource} from "./content-build.mjs";

const config = JSON.parse(fs.readFileSync("output/node-startup-20261030/experiment.json", "utf8"));
const baselineFile = path.join(config.baselineRoot, "src", "usage-core.js");
const candidateFile = path.join(config.contentRoot, "src", "usage-core.js");
const codexThreadFile = path.join(config.contentRoot, "src", "perf-sources", "codex-thread.js");
const stamp = Date.now();
const baseline = await import(`${pathToFileURL(baselineFile).href}?baseline=${stamp}`);
const candidate = await import(`${pathToFileURL(candidateFile).href}?candidate=${stamp}`);
const {createCodexProjectionCache} = await import(`${pathToFileURL(codexThreadFile).href}?candidate=${stamp}`);

function tempRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function rollout(threadId, filler = 0) {
  const rows = [
    {type: "session_meta", payload: {id: threadId, session_id: threadId, source: "cli"}},
    {type: "turn_context", payload: {thread_id: threadId, turn_id: "turn-1", model: "synthetic-model"}},
    {
      type: "token_usage_record",
      timestamp: "2026-10-30T00:00:00.000Z",
      payload: {
        thread_id: threadId,
        turn_id: "turn-1",
        response_id: "response-1",
        usage: {output_tokens: 12},
        turn_token_usage: {output_tokens: 12},
      },
    },
  ];
  if (filler > 0) rows.push({type: "world_state", payload: {padding: "A".repeat(filler)}});
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function makeHome(root, filler = 0) {
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions, {recursive: true});
  const file = path.join(sessions, "rollout-a.jsonl");
  const text = rollout("Thread-A", filler);
  fs.writeFileSync(file, text);
  return {
    root,
    file,
    fillerOffset: text.indexOf('"padding":"') + '"padding":"'.length,
    home: {id: "codex", kind: "codex", path: root},
  };
}

test("candidate is the exact anchor-checked rebuild", () => {
  const baselineText = fs.readFileSync(baselineFile, "utf8");
  const candidateText = fs.readFileSync(candidateFile, "utf8");
  assert.equal(candidateText, rebuildContentSource(baselineText));
  for (const anchor of CONTENT_ANCHORS) assert.equal(candidateText.split(anchor).length - 1, 1);
});

test("one-pass fingerprint and prefix evidence match baseline across sizes and failures", async (t) => {
  const root = tempRoot(t, "content-parity");
  const files = [0, 1, 64 * 1024, 64 * 1024 + 1, 200_000].map((size, index) => {
    const file = path.join(root, `${index}.jsonl`);
    fs.writeFileSync(file, Buffer.alloc(size, 65 + index));
    return file;
  });
  const walFile = path.join(root, "wal.jsonl");
  fs.writeFileSync(walFile, Buffer.alloc(70_000, 90));
  fs.writeFileSync(`${walFile}-wal`, Buffer.alloc(80_000, 91));
  files.push(walFile);
  const missing = path.join(root, "missing.jsonl");
  const expected = baseline.perfHomeContentFingerprint({kind: "codex"}, [...files, missing], null, true);
  const actual = candidate.perfHomeContentFingerprint({kind: "codex"}, [...files, missing], null, true);
  assert.deepEqual(actual, expected);
  const expectedAsync = await baseline.codexPlanningFingerprintAsync({kind: "codex"}, [...files, missing]);
  const actualAsync = await candidate.codexPlanningFingerprintAsync({kind: "codex"}, [...files, missing]);
  assert.deepEqual(actualAsync, expectedAsync);
  assert.equal(actual.complete, false);
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    assert.deepEqual(actual.filePrefixEvidence[file], {
      size: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
  }
});

test("unavailable full prefix preserves the readable probe and never completes an unreadable empty file", async (t) => {
  const root = tempRoot(t, "content-read-failure");
  const middle = path.join(root, "middle.jsonl");
  const empty = path.join(root, "empty.jsonl");
  fs.writeFileSync(middle, Buffer.alloc(400_000, 65));
  fs.writeFileSync(empty, "");
  const openSync = fs.openSync;
  const readSync = fs.readSync;
  const open = fsp.open;
  fs.openSync = function(file, ...args) {
    if (file === empty) throw Error("unreadable empty fixture");
    return openSync.call(this, file, ...args);
  };
  fs.readSync = function(handle, buffer, offset, length, position) {
    if (position === 64 * 1024) throw Error("unreadable middle fixture");
    return readSync.call(this, handle, buffer, offset, length, position);
  };
  fsp.open = async function(file, ...args) {
    if (file === empty) throw Error("unreadable empty fixture");
    const handle = await open.call(this, file, ...args);
    if (file === middle) handle.read = async () => { throw Error("unavailable async prefix"); };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const files = [middle, empty];
    assert.deepEqual(candidate.perfHomeContentFingerprint({kind: "codex"}, files, null, true),
      baseline.perfHomeContentFingerprint({kind: "codex"}, files, null, true));
    const actual = await candidate.codexPlanningFingerprintAsync({kind: "codex"}, files);
    assert.deepEqual(actual, await baseline.codexPlanningFingerprintAsync({kind: "codex"}, files));
    assert.equal(actual.complete, false);
    assert.equal(Object.keys(actual.filePrefixEvidence).length, 0);
    assert.equal(Object.keys(actual.fileFingerprints).length, 2);
  } finally {
    fs.openSync = openSync; fs.readSync = readSync; fsp.open = open;
    syncBuiltinESMExports();
  }
});

test("append after the pre-window is proven without weakening the after probe", async (t) => {
  const root = tempRoot(t, "content-append");
  const fixture = makeHome(root);
  const cache = createCodexProjectionCache();
  const lookup = cache.lookup.bind(cache);
  let injected = false;
  cache.lookup = (options) => {
    if (!injected) {
      injected = true;
      fs.appendFileSync(fixture.file, `${JSON.stringify({type: "world_state", payload: {appended: true}})}\n`);
    }
    return lookup(options);
  };
  const result = await candidate.planStableCodexHome({...fixture.home, projectionCache: cache});
  assert.equal(injected, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stable, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.liveChangedThreadIds, ["Thread-A"]);
  assert.deepEqual(result.before.filePrefixEvidence[fixture.file], {
    size: Buffer.byteLength(rollout("Thread-A")),
    digest: createHash("sha256").update(rollout("Thread-A")).digest("hex"),
  });
  assert.notEqual(result.before.fingerprint, result.after.fingerprint);
});

test("same-size growth with a middle rewrite fails append proof", async (t) => {
  const root = tempRoot(t, "content-middle");
  const fixture = makeHome(root, 100_000);
  const cache = createCodexProjectionCache();
  const lookup = cache.lookup.bind(cache);
  let injected = false;
  cache.lookup = (options) => {
    if (!injected) {
      injected = true;
      const handle = fs.openSync(fixture.file, "r+");
      try {
        fs.writeSync(handle, Buffer.from("B"), 0, 1, fixture.fillerOffset + 20);
      } finally {
        fs.closeSync(handle);
      }
      fs.appendFileSync(fixture.file, `${JSON.stringify({type: "world_state", payload: {appended: true}})}\n`);
    }
    return lookup(options);
  };
  const result = await candidate.planStableCodexHome({...fixture.home, projectionCache: cache});
  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(result.stable, false);
  assert.equal(result.code, "LIVE_SOURCE_CHANGED");
});
