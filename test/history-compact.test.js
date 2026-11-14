import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertHistoryArchiveSourceMatches,
  createHistoryArchiveCandidate,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { compactHistoryDatabase, compareHistoryDatabases, syncHistoryArchiveFiles } from "../src/history-compact.js";
import { getPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { createStoredQuotaSourceResolver } from "../src/usage-quota-source-store.js";
import { UsageStore } from "../src/usage-store.js";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-compact-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("archive flush opens only the two new files with r+, awaits sync and closes on failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const databaseFile = path.join(directory, "new.archive.sqlite");
  const manifestFile = path.join(directory, "new.archive.manifest.json");
  const sourceFile = path.join(directory, "source.sqlite");
  for (const file of [databaseFile, manifestFile, sourceFile]) await fs.writeFile(file, path.basename(file));
  const open = fs.open;
  const failure = new Error("injected archive flush failure");
  for (const failedFile of [null, databaseFile, manifestFile]) {
    const operations = [];
    const mockedOpen = t.mock.method(fs, "open", async (file, flags) => {
      operations.push(["open", file, flags]);
      const handle = await open(file, flags);
      const sync = handle.sync.bind(handle),
        close = handle.close.bind(handle);
      handle.sync = async () => {
        operations.push(["sync", file]);
        if (file === failedFile) throw failure;
        await sync();
      };
      handle.close = async () => {
        await close();
        operations.push(["close", file]);
      };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      if (failedFile) await assert.rejects(syncHistoryArchiveFiles(databaseFile), (error) => error === failure);
      else await syncHistoryArchiveFiles(databaseFile);
      const files = failedFile === databaseFile ? [databaseFile] : [databaseFile, manifestFile];
      assert.deepEqual(
        operations,
        files.flatMap((file) => [
          ["open", file, "r+"],
          ["sync", file],
          ["close", file],
        ]),
      );
    } finally {
      mockedOpen.mock.restore();
      syncBuiltinESMExports();
    }
  }
  for (const file of [databaseFile, manifestFile, sourceFile]) {
    assert.equal(await fs.readFile(file, "utf8"), path.basename(file));
  }
});

test("comparison covers every table, exact storage types, 64-bit rowids and WITHOUT ROWID keys", async (t) => {
  const directory = await temporaryDirectory(t);
  const originalFile = path.join(directory, "original.sqlite");
  const copiedFile = path.join(directory, "copied.sqlite");
  const original = new DatabaseSync(originalFile);
  try {
    original.exec(`
      CREATE TABLE events(id INTEGER PRIMARY KEY,total INTEGER);
      INSERT INTO events VALUES (1,10);
      CREATE TABLE auxiliary_values(name TEXT PRIMARY KEY,value ANY) STRICT;
      INSERT INTO auxiliary_values(rowid,name,value) VALUES
        (-8,'real',1.0),(42,'blob',X'00FF'),(100,'null',NULL),
        (101,'text','中文' || char(0) || 'end'),(9223372036854775807,'integer',9007199254740993);
      CREATE TABLE keyed(account TEXT,ordinal INTEGER,payload BLOB,PRIMARY KEY(account,ordinal)) WITHOUT ROWID;
      INSERT INTO keyed VALUES ('a',-2,X'00'),('b',9,X'FF');
      PRAGMA user_version=24;
    `);
  } finally {
    original.close();
  }
  const originalBytes = await fs.readFile(originalFile);
  await compactHistoryDatabase(originalFile, copiedFile);
  const copiedBytes = await fs.readFile(copiedFile);
  const proofs = compareHistoryDatabases(originalFile, copiedFile);
  assert.deepEqual(
    proofs.map(({ table, rows, rowid }) => ({ table, rows, rowid })),
    [
      { table: "auxiliary_values", rows: 5, rowid: true },
      { table: "events", rows: 1, rowid: true },
      { table: "keyed", rows: 2, rowid: false },
    ],
  );
  for (const proof of proofs) assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(compareHistoryDatabases(copiedFile, originalFile), proofs);
  const changedFile = path.join(directory, "changed.sqlite");
  for (const [sql, error] of [
    ["UPDATE auxiliary_values SET value=1 WHERE name='real'", /auxiliary_values: value or identity/],
    ["UPDATE auxiliary_values SET value=X'00FE' WHERE name='blob'", /auxiliary_values: value or identity/],
    ["UPDATE auxiliary_values SET rowid=-9 WHERE name='real'", /auxiliary_values: value or identity/],
    ["UPDATE auxiliary_values SET value=9007199254740994 WHERE name='integer'", /auxiliary_values: value or identity/],
    ["UPDATE auxiliary_values SET value='' WHERE name='null'", /auxiliary_values: value or identity/],
    [
      "UPDATE auxiliary_values SET value='中文' || char(0) || 'changed' WHERE name='text'",
      /auxiliary_values: value or identity/,
    ],
    ["UPDATE keyed SET ordinal=10 WHERE account='b'", /keyed: value or identity/],
    ["DELETE FROM keyed WHERE account='b'", /keyed: row count/],
    ["CREATE INDEX extra_index ON events(total)", /database schemas differ/],
    ["PRAGMA user_version=23", /database headers differ/],
  ]) {
    await fs.copyFile(copiedFile, changedFile);
    const changed = new DatabaseSync(changedFile);
    try {
      changed.exec(sql);
    } finally {
      changed.close();
    }
    assert.throws(() => compareHistoryDatabases(originalFile, changedFile), error, sql);
  }
  assert.deepEqual(await fs.readFile(originalFile), originalBytes);
  assert.deepEqual(await fs.readFile(copiedFile), copiedBytes);
});

test("future archive candidates remove freelist space, preserve quota identities and verify before publication", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourceFile = path.join(directory, "source.sqlite");
  const candidateFile = path.join(directory, "candidate.sqlite");
  const startMs = Date.parse("2026-01-02T00:00:00Z");
  const endMs = startMs + 60_000;
  const store = new UsageStore({ databaseFile: sourceFile, homeDir: directory, env: {}, importDirs: [] });
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run("/fixture/source", "codex", "home", "Home", directory, 1, 1, "now");
    const insert = store.database.prepare(`INSERT INTO events (
      id,source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning
    ) VALUES (?,'/fixture/source',?,'session','home','Home','main','fixture','gpt-6-sol',
      'hour','day','week','month',10,8,0,2,0)`);
    for (const [id, time] of [
      [-11, startMs],
      [70, endMs],
      [101, startMs + 1],
    ])
      insert.run(id, time);
    store.database
      .prepare(`INSERT INTO quota_usage_sources
      (rowid,source_path,home_id,session_id,timestamp_ms,quota_source,until_ms)
      VALUES (-7,'old','home','session',?,'external',0),
        (7,'z-credits','home','session',?,'credits',?),
        (100,'a-plan','home','session',?,'plan',0)`)
      .run(startMs - 1, startMs, endMs, startMs);
    store.database.exec(`CREATE TABLE compact_padding(payload BLOB);
      INSERT INTO compact_padding VALUES (zeroblob(4194304));
      DELETE FROM compact_padding;`);
  } finally {
    store.close();
  }
  const sourceBytes = await fs.readFile(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    const freePages = source.prepare("PRAGMA freelist_count").get().freelist_count;
    assert.ok(freePages > 900, "fixture must contain substantial reusable pages");
    const quotaSql = "SELECT rowid,* FROM quota_usage_sources ORDER BY rowid";
    const quotaRows = source.prepare(quotaSql).all();
    assert.deepEqual(
      quotaRows.map((row) => row.rowid),
      [-7, 7, 100],
    );
    const sourceFiles = await fs.readdir(directory);
    const sourceWalBytes = await fs.readFile(`${sourceFile}-wal`);
    const pricing = getPricingCatalog();
    const snapshot = {
      formatVersion: 1,
      threads: [{ threadId: "session", turns: [{ time: startMs, tier: "priority" }] }],
    };
    const options = { startMs, endMs, serviceTierEvidence: serviceTierEvidenceFromSnapshot(snapshot) };
    const flushed = [];
    const archiveFiles = [candidateFile, path.join(directory, "candidate.manifest.json")];
    const open = fs.open;
    const mockedOpen = t.mock.method(fs, "open", async (file, flags) => {
      const handle = await open(file, flags);
      if (archiveFiles.includes(String(file))) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          flushed.push([file, flags]);
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await createHistoryArchiveCandidate(source, candidateFile, options);
      assert.deepEqual(
        flushed,
        archiveFiles.map((file) => [file, "r+"]),
      );
    } finally {
      mockedOpen.mock.restore();
      syncBuiltinESMExports();
    }
    const verified = await verifyHistoryArchiveCandidate(candidateFile);
    assertHistoryArchiveSourceMatches(source, verified);
    assert.equal(verified.candidate.events.rows, 2);
    assert.equal(verified.candidate.sources.rows, 1);
    assert.equal(verified.manifest.schemaVersion, 25);
    assert.deepEqual(verified.manifest.pricing.catalog, pricing);
    assert.deepEqual(verified.manifest.serviceTierEvidence.snapshot, snapshot);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      assert.deepEqual(
        candidate.prepare("SELECT * FROM events ORDER BY id").all(),
        source.prepare("SELECT * FROM events WHERE timestamp_ms>=? AND timestamp_ms<? ORDER BY id").all(startMs, endMs),
      );
      assert.deepEqual(candidate.prepare(quotaSql).all(), quotaRows);
      for (const database of [source, candidate]) {
        assert.equal(createStoredQuotaSourceResolver(database, null)("home", "session", startMs + 1), "plan");
      }
      assert.ok(candidate.prepare("PRAGMA freelist_count").get().freelist_count < freePages / 10);
      assert.equal(candidate.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
      assert.equal(candidate.prepare("SELECT COUNT(*) AS n FROM compact_padding").get().n, 0);
    } finally {
      candidate.close();
    }
    const candidateBytes = (await fs.stat(candidateFile)).size;
    assert.ok(
      candidateBytes < sourceBytes.length / 2,
      `${candidateBytes} must be much smaller than ${sourceBytes.length}`,
    );
    assert.equal(verified.manifest.database.bytes, candidateBytes);

    // A non-core table mutation must fail before a manifest can bless the altered copy.
    const link = fs.link;
    let injected = 0;
    const mockedLink = t.mock.method(fs, "link", async (from, to) => {
      await link(from, to);
      if (path.basename(String(to)) !== "candidate-compact.sqlite") return;
      const altered = new DatabaseSync(to);
      try {
        altered.exec("INSERT INTO compact_padding VALUES (X'01')");
        injected++;
      } finally {
        altered.close();
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createHistoryArchiveCandidate(source, path.join(directory, "rejected.sqlite"), options),
        /compact_padding: row count/,
      );
      assert.equal(injected, 1);
    } finally {
      mockedLink.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      ["candidate.manifest.json", "candidate.sqlite", ...sourceFiles].sort(),
    );
    assert.deepEqual(await fs.readFile(sourceFile), sourceBytes);
    assert.deepEqual(await fs.readFile(`${sourceFile}-wal`), sourceWalBytes);
    assert.equal(source.prepare("SELECT COUNT(*) AS n FROM events").get().n, 3);
  } finally {
    source.close();
  }
});
