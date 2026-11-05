import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsSourceProof } from "../src/usage-source-native.js";
import { UsageStore } from "../src/usage-store.js";

const helper = process.env.Q6_TEST_HELPER;
const options = { skip: process.platform !== "win32" || !helper || !existsSync(helper) };
const FILE_COUNT = 24;
const APPEND_ROUNDS = 96;
const OVERWRITE = 0x00000001;
const EXTEND = 0x00000002;
const BASIC_INFO_CHANGE = 0x00008000;
const CLOSE = 0x80000000;

async function fixture(t) {
  assert.equal(path.extname(helper).toLowerCase(), ".exe", "Q6_TEST_HELPER must select an explicit native executable");
  const temporary = path.resolve(os.homedir(), "AppData", "Local", "Temp");
  assert.equal(path.parse(temporary).root.toLowerCase(), "c:\\", "native fixtures require ordinary C: storage");
  await mkdir(temporary, { recursive: true });
  assert.equal((await realpath(temporary)).toLowerCase(), temporary.toLowerCase(), "temp root must not be redirected");
  const root = await mkdtemp(path.join(temporary, "usage-coalescing-"));
  const native = new WindowsSourceProof(helper);
  t.after(async () => {
    native.close();
    assert.equal(path.dirname(path.resolve(root)), temporary);
    assert.ok(path.basename(root).startsWith("usage-coalescing-"));
    assert.equal((await realpath(root)).toLowerCase(), path.resolve(root).toLowerCase());
    await rm(root, { recursive: true, force: true });
  });
  return { root, native };
}

async function ordinaryFiles(directory) {
  const files = [];
  for (let index = 0; index < FILE_COUNT; index++) {
    const file = path.join(directory, `${index}.txt`);
    await writeFile(file, Buffer.alloc(4096, 97));
    files.push(file);
  }
  return files;
}

async function repeatAppends(files) {
  assert.ok(files.length * APPEND_ROUNDS > 2048);
  // Each awaited appendFile opens and closes its own handle, rather than sharing one USN write episode.
  for (let round = 0; round < APPEND_ROUNDS; round++) {
    for (const file of files) await appendFile(file, "x");
  }
}

function intervalAssertions(interval, cursor, native) {
  assert.ok(interval, `directory interval must remain available: ${JSON.stringify(native.lastDirectoryFailure)}`);
  assert.equal(interval.format, 1);
  assert.equal(interval.journalId, cursor.journalId);
  assert.equal(interval.startUsn, cursor.nextUsn);
  assert.ok(interval.journalBytes > 0 && interval.journalBytes <= 4 * 1024 * 1024);
  assert.ok(interval.records.length <= 2048);
  assert.equal(new Set(interval.records.map((record) => record.id)).size, interval.records.length, "IDs must be unique");
  let previous = BigInt(cursor.nextUsn) - 1n;
  for (const record of interval.records) {
    assert.notEqual(record.reason, CLOSE, "pure CLOSE records must remain excluded");
    assert.ok(BigInt(record.usn) > previous, "coalesced latest USNs must be strictly ascending");
    assert.ok(BigInt(record.usn) < BigInt(interval.nextUsn));
    previous = BigInt(record.usn);
  }
}

function targetChange(interval, object) {
  const records = interval.records.filter((record) => record.id === object.id64 || record.id === object.id128);
  assert.equal(records.length, 1, "each changed fixture object must appear exactly once");
  return records[0];
}

test("native coalesces 2305 separate appends on 24 objects and retains their latest USNs", options, async (t) => {
  const { root, native } = await fixture(t);
  const files = await ordinaryFiles(root);
  const objects = [];
  for (const file of files) {
    const object = await native.object(file);
    assert.ok(object);
    objects.push(object);
  }
  const cursor = await native.journal(root);
  assert.ok(cursor, "requires an available C: NTFS journal");
  await repeatAppends(files);
  const beforeLastAppend = await native.journal(root);
  assert.ok(beforeLastAppend);
  await appendFile(files[0], "last");

  const interval = await native.changes(root, cursor);
  intervalAssertions(interval, cursor, native);
  for (const object of objects) assert.equal(targetChange(interval, object).reason & EXTEND, EXTEND);
  const last = await native.changes(root, beforeLastAppend);
  intervalAssertions(last, beforeLastAppend, native);
  assert.equal(targetChange(interval, objects[0]).usn, targetChange(last, objects[0]).usn, "retain the last, not first, USN");
  assert.ok(BigInt(targetChange(interval, objects[0]).usn) >= BigInt(beforeLastAppend.nextUsn));
});

test("native ORs overwrite, append and metadata reasons without certifying a mixed rewrite as append-only", options, async (t) => {
  const { root, native } = await fixture(t);
  const file = path.join(root, "mixed.txt");
  await writeFile(file, Buffer.alloc(4096, 97));
  const timestamp = new Date("2026-11-05T01:00:00.000Z");
  await utimes(file, timestamp, timestamp);
  const before = await stat(file);
  const object = await native.object(file);
  assert.ok(object);
  const fence = await native.begin(file, 0, before);
  assert.ok(fence);
  const sealed = await native.advance(file, fence, before.size, before);
  assert.ok(sealed);
  assert.ok(await native.verify(file, sealed.validation, before.size, before), "the original prefix must be certifiable");
  const cursor = await native.journal(root);
  assert.ok(cursor);

  const writer = await open(file, "r+");
  try { assert.equal((await writer.write(Buffer.from("b"), 0, 1, 0)).bytesWritten, 1); }
  finally { await writer.close(); }
  const split = await native.journal(root);
  assert.ok(split);
  const first = await native.changes(root, cursor);
  intervalAssertions(first, cursor, native);
  const overwritten = targetChange(first, object);
  assert.equal(overwritten.reason & OVERWRITE, OVERWRITE);

  await appendFile(file, "suffix");
  await utimes(file, before.atime, before.mtime);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, "restore mtime without hiding the overwrite");
  const tail = await native.changes(root, split);
  intervalAssertions(tail, split, native);
  const appended = targetChange(tail, object);
  assert.equal(appended.reason & EXTEND, EXTEND);
  assert.equal(appended.reason & BASIC_INFO_CHANGE, BASIC_INFO_CHANGE);
  const merged = await native.changes(root, cursor);
  intervalAssertions(merged, cursor, native);
  const combined = targetChange(merged, object);
  assert.equal(combined.reason, (overwritten.reason | appended.reason) >>> 0, "retain the complete reason union");
  assert.equal(combined.reason & (OVERWRITE | EXTEND), OVERWRITE | EXTEND);
  assert.equal(combined.usn, appended.usn);
  assert.equal(await native.verify(file, sealed.validation, before.size, after), null, "mixed writes cannot authorize append reuse");
});

test("native retains both parent fragments and rename reasons when an object moves", options, async (t) => {
  const { root, native } = await fixture(t);
  const RENAME_OLD = 0x00001000, RENAME_NEW = 0x00002000;
  const left = path.join(root, "left"), right = path.join(root, "right");
  await mkdir(left);
  await mkdir(right);
  const oldParent = await native.object(left), newParent = await native.object(right);
  assert.ok(oldParent);
  assert.ok(newParent);
  const file = path.join(left, "moved.txt"), moved = path.join(right, "moved.txt");
  await writeFile(file, "initial");
  const object = await native.object(file);
  assert.ok(object);
  const cursor = await native.journal(root);
  assert.ok(cursor);
  await appendFile(file, "changed");
  await rename(file, moved);
  await appendFile(moved, "after-move");
  const current = await native.object(moved);
  assert.ok(current);
  assert.equal(current.id64, object.id64);
  assert.equal(current.id128, object.id128);
  const interval = await native.changes(root, cursor);
  assert.ok(interval, `moving an outside object must not reject the interval: ${JSON.stringify(native.lastDirectoryFailure)}`);
  assert.equal(interval.format, 1);
  assert.ok(interval.records.length <= 2048);
  const records = interval.records.filter((record) => record.id === object.id64 || record.id === object.id128);
  assert.equal(records.length, 2, "retain one fragment for each parent, even though their object ID is identical");
  assert.equal(records[0].id, records[1].id);
  const previous = records.find((record) => record.parent === oldParent.id64 || record.parent === oldParent.id128);
  const present = records.find((record) => record.parent === newParent.id64 || record.parent === newParent.id128);
  assert.ok(previous, "retain the original parent evidence");
  assert.ok(present, "retain the current parent evidence");
  assert.equal(previous.reason & (RENAME_OLD | EXTEND), RENAME_OLD | EXTEND);
  assert.equal(present.reason & (RENAME_NEW | EXTEND), RENAME_NEW | EXTEND);
  assert.ok(BigInt(previous.usn) >= BigInt(cursor.nextUsn));
  assert.ok(BigInt(previous.usn) < BigInt(present.usn));
  assert.ok(BigInt(present.usn) < BigInt(interval.nextUsn));
});

const token = (total, second) => JSON.stringify({
  type: "event_msg", timestamp: `2026-11-05T01:00:0${second}.000Z`,
  payload: { type: "token_count", info: { total_token_usage: {
    input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total,
  } } },
});

test("UsageStore remains certified without full enumeration after 2304 outside appends", options, async (t) => {
  const { root, native } = await fixture(t);
  const homeDir = path.join(root, "home");
  const source = path.join(homeDir, ".codex", "sessions", "source.jsonl");
  const outside = path.join(root, "outside");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(outside);
  const files = await ordinaryFiles(outside);
  await writeFile(source, [
    JSON.stringify({ type: "session_meta", payload: {
      id: "coalescing-source", source: "cli", originator: "codex-tui", cwd: root, model_provider: "openai",
    } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }), token(10, 1), "",
  ].join("\n"));
  const store = new UsageStore({ homeDir, env: {}, importDirs: [], databaseFile: path.join(root, "index.sqlite") });
  store.sourceProof.provider = async () => native;
  store.sourceProof.close = () => native.close();
  store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  const facts = () => ({ ...store.database.prepare("SELECT SUM(total) total, COUNT(*) count FROM events").get() });
  try {
    const initial = await store.sync({ forceFull: true });
    assert.ok(initial.acquisition, JSON.stringify(store.lastAcquisitionWork));
    assert.equal(initial.fileCount, 1);
    assert.deepEqual(facts(), { total: 10, count: 1 });
    store.usageFiles = () => { assert.fail("certified checks must not enumerate usage sources"); };
    await repeatAppends(files);
    const checked = await store.sync({ certifiedOnly: true });
    assert.ok(checked?.acquisition, JSON.stringify(store.lastAcquisitionWork));
    assert.equal(store.lastAcquisitionWork.mode, "certified");
    assert.equal(store.lastAcquisitionWork.selectedFiles, 0);
    assert.ok(store.lastAcquisitionWork.records >= FILE_COUNT && store.lastAcquisitionWork.records <= 2048);
    assert.deepEqual(facts(), { total: 10, count: 1 });
    await appendFile(source, `${token(20, 2)}\n`);
    const updated = await store.sync({ certifiedOnly: true });
    assert.ok(updated?.acquisition, JSON.stringify(store.lastAcquisitionWork));
    assert.equal(updated.updatedFileCount, 1);
    assert.equal(store.lastAcquisitionWork.selectedFiles, 1);
    assert.equal(store.lastSyncSourceWork.appendedFiles, 1);
    assert.equal(store.lastSyncSourceWork.replacedFiles, 0);
    assert.deepEqual(facts(), { total: 20, count: 2 });
    const beforeRename = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    await rename(source, path.join(outside, "source.jsonl"));
    assert.equal(await store.sync({ certifiedOnly: true }), null, "a managed source move must refuse certified reuse");
    assert.equal(store.lastAcquisitionWork.mode, "fallback");
    assert.match(store.lastAcquisitionWork.reason, /known namespace changed/);
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), beforeRename, "refusal must retain every fact");
    assert.deepEqual(facts(), { total: 20, count: 2 });
  } finally { store.close(); }
});
