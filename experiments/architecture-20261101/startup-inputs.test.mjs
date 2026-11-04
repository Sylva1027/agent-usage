import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { captureStartupInputs, inventoryStartupInputs } from "./startup-inputs.mjs";

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function createSqlite(filePath, value, { keepOpen = false } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE facts (value TEXT NOT NULL) STRICT;");
  database.prepare("INSERT INTO facts (value) VALUES (?)").run(value);
  if (keepOpen) return database;
  database.close();
  return null;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-inputs-"));
  const homeDir = path.join(root, "home");
  const outputDirectory = path.join(root, "output");
  const fixture = {
    root,
    homeDir,
    outputDirectory,
    files: {},
    openDatabases: [],
  };

  fixture.files.codex = path.join(homeDir, ".codex", "sessions", "project", "session.jsonl");
  fixture.files.dsh = path.join(
    homeDir,
    ".dsh",
    "sessions",
    "project",
    "session-one",
    "session.v1.jsonl.zstd",
  );
  fixture.files.claude = path.join(homeDir, ".claude", "projects", "project", "session.jsonl");
  fixture.files.workbuddy = path.join(homeDir, ".workbuddy-ai", "projects", "project", "session.jsonl");
  fixture.files.zcode = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  fixture.files.opencode = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  fixture.files.extra = path.join(homeDir, ".codex", "config.toml");
  fixture.files.importLog = path.join(root, "log-project", ".codex-usage", "usage.jsonl");
  fixture.importStore = path.join(root, "imports.json");
  fixture.activeIndex = path.join(root, "active-index.sqlite");

  for (const key of ["codex", "dsh", "claude"]) {
    await mkdir(path.dirname(fixture.files[key]), { recursive: true });
    await writeFile(fixture.files[key], "{}\n");
  }
  await mkdir(path.dirname(fixture.files.workbuddy), { recursive: true });
  await writeFile(fixture.files.workbuddy, '{"type":"session-meta","sessionId":"fixture"}\n');
  fixture.openDatabases.push(
    await createSqlite(fixture.files.zcode, "wal-committed-zcode", { keepOpen: true }),
  );
  fixture.openDatabases.push(
    await createSqlite(fixture.files.opencode, "wal-committed-opencode", { keepOpen: true }),
  );
  await writeFile(fixture.files.extra, "model = 'fixture'\n");
  await mkdir(path.dirname(fixture.files.importLog), { recursive: true });
  await writeFile(fixture.files.importLog, "");
  await writeFile(
    fixture.importStore,
    JSON.stringify({ imports: [{ path: path.dirname(fixture.files.importLog) }] }),
  );

  const active = new DatabaseSync(fixture.activeIndex);
  active.exec(
    `PRAGMA journal_mode = WAL;
     CREATE TABLE source_files (
       path TEXT PRIMARY KEY, kind TEXT NOT NULL, home_id TEXT NOT NULL,
       home_label TEXT NOT NULL, home_path TEXT NOT NULL,
       size INTEGER NOT NULL, mtime_ms REAL NOT NULL, indexed_at TEXT NOT NULL
     ) STRICT;`,
  );
  const insert = active.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [index, kind] of ["main", "zcode", "dsh", "opencode", "claude", "workbuddy"].entries()) {
    insert.run(`/indexed/${index}`, kind, `home-${index}`, kind, "/home", 10, 1, "2026-11-02T00:00:00Z");
  }
  fixture.openDatabases.push(active);
  return fixture;
}

async function closeFixture(fixture) {
  for (const database of fixture.openDatabases) database?.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function inventoryOptions(fixture) {
  return {
    homeDir: fixture.homeDir,
    env: {},
    importDirs: [],
    importStoreFile: fixture.importStore,
    activeIndexFile: fixture.activeIndex,
  };
}

test("inventory discovers six source families, imports, and reads the active index read-only", async () => {
  const fixture = await createFixture();
  try {
    const indexHashBefore = await hashFile(fixture.activeIndex);
    const indexWalHashBefore = await hashFile(`${fixture.activeIndex}-wal`);
    const result = await inventoryStartupInputs({
      outputDirectory: fixture.outputDirectory,
      options: inventoryOptions(fixture),
    });
    assert.equal(result.summary.sourceCount, 7);
    assert.equal(result.summary.fileCount, 7);
    assert.equal(result.summary.bySource.codex.fileCount, 1);
    assert.equal(result.summary.bySource.zcode.fileCount, 1);
    assert.equal(result.summary.bySource.dsh.fileCount, 1);
    assert.equal(result.summary.bySource.opencode.fileCount, 1);
    assert.equal(result.summary.bySource.claude.fileCount, 1);
    assert.equal(result.summary.bySource.workbuddy.fileCount, 1);
    assert.equal(result.summary.bySource["project-log"].fileCount, 1);
    assert.equal(result.manifest.importStore.status, "read");
    assert.equal(result.manifest.files.find((file) => file.sourceKind === "zcode").storageType, "sqlite");
    assert.equal(result.manifest.files.find((file) => file.sourceKind === "opencode").storageType, "sqlite");
    assert.equal(result.manifest.activeIndex.sixSourceFileCount, 6);
    assert.equal(result.manifest.activeIndex.sixSourceKnownBytes, 60);
    assert.equal(result.manifest.scope.originalInputsComplete, false);
    assert.equal(await hashFile(fixture.activeIndex), indexHashBefore);
    assert.equal(await hashFile(`${fixture.activeIndex}-wal`), indexWalHashBefore);
    assert.match(await readFile(result.manifestFile, "utf8"), /wal-committed-zcode|db\.sqlite/);
  } finally {
    await closeFixture(fixture);
  }
});

test("capture preserves mtimes and backs up committed WAL without touching source databases", async () => {
  const fixture = await createFixture();
  try {
    const inventory = await inventoryStartupInputs({
      outputDirectory: fixture.outputDirectory,
      options: inventoryOptions(fixture),
    });
    const sourceBefore = {
      zcode: await stat(fixture.files.zcode),
      zcodeWal: await stat(`${fixture.files.zcode}-wal`),
      codex: await stat(fixture.files.codex),
    };
    const hashesBefore = {
      zcode: await hashFile(fixture.files.zcode),
      zcodeWal: await hashFile(`${fixture.files.zcode}-wal`),
      codex: await hashFile(fixture.files.codex),
    };

    const capture = await captureStartupInputs(inventory.manifest, {
      outputDirectory: fixture.outputDirectory,
      extraFiles: [{ path: fixture.files.extra, role: "config" }],
    });
    assert.equal(capture.summary.fileCount, 8);
    assert.equal(capture.summary.failureCount, 0);
    assert.equal(capture.summary.sqliteCount, 2);
    assert.equal(capture.summary.originalInputsComplete, false);
    assert.equal(
      capture.manifest.files.every((file) => file.mtimePreserved),
      true,
      JSON.stringify(
        capture.manifest.files.map((file) => ({
          path: file.logicalPath,
          source: file.sourceBefore.mtimeMs,
          captured: file.capturedStat.mtimeMs,
        })),
      ),
    );
    assert.equal(capture.manifest.files.filter((file) => file.storageType === "sqlite").length, 2);
    assert.equal(capture.manifest.files.every((file) => file.sourceBefore && file.sourceAfter), true);
    assert.equal(capture.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.equal(
      capture.manifest.files.some((file) => file.role === "config" && file.logicalPath === fixture.files.extra),
      true,
    );
    assert.equal(
      capture.manifest.files.some((file) => file.sqlite?.method === "sqlite-backup" && file.sqlite.quickCheck === "ok"),
      true,
    );
    assert.equal(capture.manifest.scope.originalInputsComplete, false);
    assert.equal(capture.manifest.directoryListings.before.length > 0, true);

    const zcodeCapture = capture.manifest.files.find((file) => file.sourceKind === "zcode");
    const backupPath = path.join(capture.manifest.captureDirectory, zcodeCapture.capturedPath);
    assert.equal(await hashFile(backupPath), zcodeCapture.sha256);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT value FROM facts").get().value, "wal-committed-zcode");
      assert.equal(backup.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    } finally {
      backup.close();
    }

    const sourceAfter = {
      zcode: await stat(fixture.files.zcode),
      zcodeWal: await stat(`${fixture.files.zcode}-wal`),
      codex: await stat(fixture.files.codex),
    };
    assert.equal(sourceAfter.zcode.size, sourceBefore.zcode.size);
    assert.equal(sourceAfter.zcode.mtimeMs, sourceBefore.zcode.mtimeMs);
    assert.equal(sourceAfter.zcodeWal.size, sourceBefore.zcodeWal.size);
    assert.equal(sourceAfter.zcodeWal.mtimeMs, sourceBefore.zcodeWal.mtimeMs);
    assert.equal(await hashFile(fixture.files.zcode), hashesBefore.zcode);
    assert.equal(await hashFile(`${fixture.files.zcode}-wal`), hashesBefore.zcodeWal);
    assert.equal(await hashFile(fixture.files.codex), hashesBefore.codex);
  } finally {
    await closeFixture(fixture);
  }
});

test("capture rejects extra inputs inside outputDirectory before writing a capture", async () => {
  const fixture = await createFixture();
  try {
    const inventory = await inventoryStartupInputs({
      outputDirectory: fixture.outputDirectory,
      options: inventoryOptions(fixture),
    });
    await writeFile(path.join(fixture.outputDirectory, "should-not-copy.txt"), "private");
    await assert.rejects(
      captureStartupInputs(inventory.manifest, {
        outputDirectory: fixture.outputDirectory,
        extraFiles: [path.join(fixture.outputDirectory, "should-not-copy.txt")],
      }),
      /must not be inside outputDirectory/,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("capture records per-file failures and still writes an honest private manifest", async () => {
  const fixture = await createFixture();
  try {
    const inventory = await inventoryStartupInputs({
      outputDirectory: fixture.outputDirectory,
      options: inventoryOptions(fixture),
    });
    await unlink(fixture.files.codex);
    const capture = await captureStartupInputs(inventory.manifest, {
      outputDirectory: fixture.outputDirectory,
    });
    assert.equal(capture.summary.failureCount, 1);
    assert.equal(capture.summary.fileCount, 6);
    assert.equal(capture.manifest.failures[0].logicalPath, fixture.files.codex);
    assert.equal(capture.manifest.scope.originalInputsComplete, false);
  } finally {
    await closeFixture(fixture);
  }
});
