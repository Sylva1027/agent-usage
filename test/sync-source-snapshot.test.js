import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, statSync, unlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

function fixture(t) {
  const input = createCodexIntegrationFixture();
  const store = new UsageStore(input.serverOptions);
  t.after(() => {
    t.mock.restoreAll();
    store.close();
    input.close();
  });
  return { input, store, sync: () => store.sync({ options: input.reportOptions, forceFull: true }) };
}

function addUsage(file) {
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-10-04T12:01:00.000Z",
      payload: { type: "token_count", info: { last_token_usage: { total_tokens: 123, input_tokens: 123 } } },
    })}\n`,
  );
  const time = new Date("2026-10-04T12:00:00.000Z");
  utimesSync(file, time, time);
}

function moveSource(from, to) {
  const info = statSync(from);
  copyFileSync(from, to);
  utimesSync(to, info.atime, info.mtime);
  unlinkSync(from);
}

function sourceRows(store) {
  return store.database.prepare("SELECT * FROM source_files ORDER BY path").all();
}

function eventRows(store) {
  return store.database.prepare("SELECT * FROM events ORDER BY id").all();
}

test("full sync streams the source snapshot without materializing all present sources", async (t) => {
  const { input, store, sync } = fixture(t);
  addUsage(input.rolloutFiles[0]);
  await sync();
  const before = sourceRows(store);
  const events = eventRows(store);
  assert.ok(events.length > 0);
  const prepare = store.database.prepare;
  const visited = [];
  let iterations = 0;
  t.mock.method(store.database, "prepare", function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (/^SELECT \* FROM source_files\s*;?$/i.test(sql.trim())) {
      statement.all = () => assert.fail("the full source snapshot must not call .all()");
      const iterate = statement.iterate;
      statement.iterate = function* (...parameters) {
        iterations++;
        for (const row of iterate.apply(this, parameters)) {
          visited.push(row.path);
          yield row;
        }
      };
    }
    return statement;
  });

  const result = await sync();
  assert.equal(iterations, 1);
  assert.deepEqual(visited.sort(), before.map((row) => row.path).sort());
  assert.equal(result.updatedFileCount, 0);
  assert.deepEqual(result.missingSources, []);
  assert.deepEqual(sourceRows(store), before);
  assert.deepEqual(eventRows(store), events);
});

test("full sync retains missing history and removes only a unique renamed source", async (t) => {
  const { input, store, sync } = fixture(t);
  const [missingPath, renameFrom] = input.rolloutFiles;
  addUsage(missingPath);
  await sync();
  const before = sourceRows(store);
  const events = eventRows(store);
  assert.ok(events.some((row) => row.source_path === missingPath));
  unlinkSync(missingPath);

  const missing = await sync();
  assert.deepEqual(missing.missingSources.map((row) => row.path), [missingPath]);
  assert.deepEqual(sourceRows(store), before);
  assert.deepEqual(eventRows(store), events);

  const renameTo = path.join(path.dirname(renameFrom), "renamed-rollout.jsonl");
  moveSource(renameFrom, renameTo);
  const renamed = await sync();
  assert.deepEqual(renamed.missingSources, missing.missingSources);
  assert.deepEqual(
    sourceRows(store).map((row) => row.path).sort(),
    [missingPath, renameTo, input.rolloutFiles[2]].sort(),
  );
  assert.deepEqual(sourceRows(store).find((row) => row.path === missingPath), before.find((row) => row.path === missingPath));
  assert.deepEqual(eventRows(store), events);
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("full sync does not merge two missing paths with the same fingerprint into one replacement", async (t) => {
  const { input, store, sync } = fixture(t);
  const [, first, second] = input.rolloutFiles;
  addUsage(first);
  copyFileSync(first, second);
  const info = statSync(first);
  utimesSync(second, info.atime, info.mtime);
  await sync();
  const fingerprints = JSON.parse(store.readMetaRaw("usage_file_fingerprints"));
  assert.equal(typeof fingerprints[first], "string");
  assert.equal(fingerprints[first], fingerprints[second]);
  const before = sourceRows(store);
  const events = eventRows(store);
  assert.ok(events.length > 0);
  const replacement = path.join(path.dirname(first), "replacement-rollout.jsonl");
  moveSource(first, replacement);
  unlinkSync(second);

  const result = await sync();
  assert.deepEqual(result.missingSources.map((row) => row.path).sort(), [first, second].sort());
  const after = sourceRows(store);
  for (const old of before.filter((row) => [first, second].includes(row.path))) {
    assert.deepEqual(after.find((row) => row.path === old.path), old);
  }
  assert.ok(after.some((row) => row.path === replacement));
  assert.deepEqual(eventRows(store).filter((row) => row.source_path !== replacement), events);
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("full sync keeps failed-home paths in rename ambiguity even when they are not reported missing", async (t) => {
  const { input, store, sync } = fixture(t);
  const [, first, second] = input.rolloutFiles;
  addUsage(input.rolloutFiles[0]);
  copyFileSync(first, second);
  const info = statSync(first);
  utimesSync(second, info.atime, info.mtime);
  await sync();
  const fingerprints = JSON.parse(store.readMetaRaw("usage_file_fingerprints"));
  assert.equal(typeof fingerprints[first], "string");
  assert.equal(fingerprints[first], fingerprints[second]);
  const failedPath = path.join(input.codexHome, "unreadable-home");
  // Same rename owner, but failed by home_path: filtering it early would make first look unique.
  store.database.prepare("UPDATE source_files SET home_path = ? WHERE path = ?").run(failedPath, second);
  const before = sourceRows(store);
  const events = eventRows(store);
  assert.ok(events.length > 0);
  const replacement = path.join(path.dirname(first), "replacement-rollout.jsonl");
  moveSource(first, replacement);
  unlinkSync(second);
  const usageFiles = store.usageFiles;
  t.mock.method(store, "usageFiles", async function (...args) {
    const scanned = await usageFiles.apply(this, args);
    return {
      ...scanned,
      warnings: [...scanned.warnings, "snapshot fixture: failed home"],
      failedHomes: [...scanned.failedHomes, { id: "snapshot-failed-home", path: failedPath }],
    };
  });

  const result = await sync();
  assert.ok(store.warnings.includes("snapshot fixture: failed home"));
  assert.deepEqual(result.missingSources.map((row) => row.path), [first]);
  const after = sourceRows(store);
  for (const old of before.filter((row) => [first, second].includes(row.path))) {
    assert.deepEqual(after.find((row) => row.path === old.path), old);
  }
  assert.ok(after.some((row) => row.path === replacement));
  assert.deepEqual(eventRows(store).filter((row) => row.source_path !== replacement), events);
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
});
