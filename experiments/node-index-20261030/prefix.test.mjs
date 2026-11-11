import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {PROFILE_ANCHORS, rebuildPrefixSource} from "./prefix-build.mjs";

const config = JSON.parse(
  await fs.readFile("output/node-index-20261030/experiment.json", "utf8"),
);
const baselineFile = path.join(config.baselineRoot, "src", "usage-core.js");
const candidateFile = path.join(config.candidateRoot, "src", "usage-core.js");

test("candidate is the exact anchor-checked rebuild", async () => {
  const [baseline, candidate] = await Promise.all([
    fs.readFile(baselineFile, "utf8"),
    fs.readFile(candidateFile, "utf8"),
  ]);
  assert.equal(candidate, rebuildPrefixSource(baseline));
  for (const anchor of PROFILE_ANCHORS) {
    assert.equal(candidate.split(anchor).length - 1, 1);
  }
  assert(!candidate.includes("node:worker_threads"));
  assert(!candidate.includes("new Worker("));
});

test("async readers match sync fingerprint and complete-prefix evidence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prefix-parity-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const large = path.join(directory, "large.jsonl");
  const medium = path.join(directory, "medium.jsonl");
  const empty = path.join(directory, "empty.jsonl");
  await fs.writeFile(large, Buffer.alloc(1024 * 1024 + 137, 0x41));
  await fs.writeFile(medium, Buffer.alloc(700 * 1024, 0x42));
  await fs.writeFile(empty, Buffer.alloc(0));
  const files = [large, medium, empty].sort();
  const moduleUrl = `${pathToFileURL(candidateFile).href}?parity=${Date.now()}`;
  const {codexPlanningFingerprintAsync, perfHomeContentFingerprint} = await import(moduleUrl);
  const home = {kind: "codex"};
  const expected = perfHomeContentFingerprint(home, files, null, true);
  const actual = await codexPlanningFingerprintAsync(home, files);
  assert.deepEqual(actual, expected);
  assert.equal(actual.complete, true);
  assert.equal(
    actual.filePrefixEvidence[empty].digest,
    createHash("sha256").update("").digest("hex"),
  );
});

test("bad paths fail closed with the same aggregate hash", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prefix-bad-path-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const good = path.join(directory, "good.jsonl");
  const missing = path.join(directory, "missing.jsonl");
  await fs.writeFile(good, "synthetic\n");
  const files = [good, missing].sort();
  const moduleUrl = `${pathToFileURL(candidateFile).href}?bad=${Date.now()}`;
  const {codexPlanningFingerprintAsync, perfHomeContentFingerprint} = await import(moduleUrl);
  const home = {kind: "codex"};
  const expected = perfHomeContentFingerprint(home, files, null, true);
  const actual = await codexPlanningFingerprintAsync(home, files);
  assert.deepEqual(actual, expected);
  assert.equal(actual.complete, false);
  assert.equal(Object.hasOwn(actual.fileFingerprints, missing), false);
  assert.equal(Object.hasOwn(actual.filePrefixEvidence, missing), false);
});
