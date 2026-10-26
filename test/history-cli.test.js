import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyPublishedHistoryArchiveBundle } from "../src/history-archive.js";
import { createHistoryBackup, HISTORY_BACKUP_SCHEMA_VERSION, loadHistoryBackupContext } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_FILE = path.join(REPO_ROOT, "src", "cli.js");

function runCli(root, args, { nodeArgs = [], env = {} } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, CLI_FILE, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: root, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function createHistoryPackage(root) {
  const importDir = path.join(root, "import");
  const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
  const options = { homeDir: root, env: {}, importDirs: [importDir] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "usage.sqlite") });
  try {
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(
      usageFile,
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "history-cli-fixture",
        channel: "Test",
        project_root: "/work/history-cli",
        cwd: "/work/history-cli",
        session_id: "history-cli-session",
        model: "gpt-6-luna",
        usage: { total: 20, input: 18, cached: 0, output: 2, reasoning: 0 },
      })}\n`,
    );
    await store.sync({ options });
    const databaseFile = path.join(root, "package", "history.sqlite");
    await createHistoryBackup(store.database, databaseFile);
    return databaseFile;
  } finally {
    store.close();
  }
}

async function createUncheckpointedSource(root) {
  const databaseFile = path.join(root, "source.sqlite");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  await store.open();
  store.database.exec(`
    PRAGMA wal_autocheckpoint = 0;
    INSERT INTO source_files VALUES (
      'uncheckpointed.jsonl', 'codex', 'home', 'Home', '${root.replaceAll("'", "''")}', 1, 1, 'now'
    );
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (
      'uncheckpointed.jsonl', 1, 'uncheckpointed-session', 'home', 'Home', 'main',
      'project', 'gpt-6-luna', 'hour', 'day', 'week', 'month', 37, 30, 4, 2, 1
    );
  `);
  return { store, databaseFile };
}

async function createArchiveSource(root, { archiveInRange = false } = {}) {
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "segments", "candidate.sqlite");
  const manifestFile = path.join(root, "segments", "candidate.manifest.json");
  const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
  const endMs = startMs + 60_000;
  const threadId = "history-cli-export-thread";
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  await store.open();
  const sourcePath = path.join(root, "source.jsonl");
  store.database.exec("PRAGMA wal_autocheckpoint = 0");
  store.database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
  const insertEvent = store.database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEvent.run(
    sourcePath,
    startMs,
    threadId,
    "home",
    "Home",
    "main",
    "project",
    "gpt-6-sol",
    "hour",
    "day",
    "week",
    "month",
    20,
    18,
    0,
    2,
    0,
  );
  insertEvent.run(
    sourcePath,
    endMs,
    "hot-session",
    "home",
    "Home",
    "main",
    "project",
    "gpt-6-sol",
    "hour",
    "day",
    "week",
    "month",
    31,
    28,
    0,
    3,
    0,
  );
  await createHistoryArchiveCandidate(store.database, candidateFile, { startMs, endMs });
  await store.registerHistoryArchiveCandidate(candidateFile);
  if (archiveInRange) {
    const segmentId = String(store.database.prepare("SELECT segment_id FROM archive_segments").get().segment_id);
    store.database.prepare("DELETE FROM events WHERE timestamp_ms = ?").run(startMs);
    store.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
      .run("history_archive_event_authority", JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
  }

  const log = new DatabaseSync(path.join(root, "logs_2.sqlite"));
  try {
    log.exec(
      "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)",
    );
    log
      .prepare(
        "INSERT INTO logs (ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, 0, ?, 'codex_core::session::handlers', ?)",
      )
      .run(
        Math.floor(startMs / 1000),
        threadId,
        `session_loop{thread_id=${threadId}}: Submission sub=Submission { id: "history-cli-export", op: TurnInput { request: { input: UserInput { content: [] }, service_tier: Some(Some("priority")), collaboration_mode: None } } }`,
      );
  } finally {
    log.close();
  }
  return { store, databaseFile, candidateFile, manifestFile, startMs, threadId };
}

function sourceState(databaseFile) {
  return {
    databaseBytes: readFileSync(databaseFile),
    walBytes: readFileSync(`${databaseFile}-wal`),
  };
}

test("history verify prints package counts and rejects a bad database digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-"));
  try {
    const databaseFile = await createHistoryPackage(root);
    const verified = runCli(root, ["history", "verify", databaseFile]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^History backup verified\./);
    assert.match(verified.stdout, /^Schema: 21$/m);
    assert.match(verified.stdout, /^- events: 1$/m);
    assert.match(verified.stdout, /^Service-tier evidence: not captured$/m);
    assert.doesNotMatch(verified.stdout, /history-cli-session|history-cli-fixture|\/work\/history-cli/);

    const manifestFile = path.join(root, "package", "history.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.database.sha256 = "0".repeat(64);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const rejected = runCli(root, ["history", "verify", databaseFile]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /History backup verification failed: HISTORY_BACKUP_DIGEST_MISMATCH:/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history backup captures an uncheckpointed commit without changing the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-backup-"));
  let source;
  try {
    source = await createUncheckpointedSource(root);
    assert.equal(
      source.store.database.prepare("PRAGMA user_version").get().user_version,
      HISTORY_BACKUP_SCHEMA_VERSION,
    );
    assert.ok(statSync(`${source.databaseFile}-wal`).size > 0);
    const sourceBytes = readFileSync(source.databaseFile);
    const sourceWalBytes = readFileSync(`${source.databaseFile}-wal`);
    assert.equal(source.store.database.prepare("SELECT SUM(total) AS total FROM events").get().total, 37);

    const packageFile = path.join(root, "package", "history.sqlite");
    const backedUp = runCli(root, ["history", "backup", source.databaseFile, packageFile, "--home-dir", root]);
    assert.equal(backedUp.status, 0, backedUp.stderr);
    assert.match(backedUp.stdout, /^History backup created\./);
    assert.ok(backedUp.stdout.includes(`Database: ${packageFile}`));
    assert.match(backedUp.stdout, /^Service-tier evidence: not captured$/m);
    assert.match(backedUp.stdout, /^Source database was not modified\.$/m);

    assert.deepEqual(readFileSync(source.databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${source.databaseFile}-wal`), sourceWalBytes);
    assert.equal(source.store.database.prepare("SELECT SUM(total) AS total FROM events").get().total, 37);

    const verified = runCli(root, ["history", "verify", packageFile]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^Schema: 21$/m);
    assert.match(verified.stdout, /^- events: 1$/m);
    assert.match(verified.stdout, /^Service-tier evidence: not captured$/m);
    const packaged = new DatabaseSync(packageFile, { readOnly: true });
    try {
      assert.equal(packaged.prepare("SELECT SUM(total) AS total FROM events").get().total, 37);
    } finally {
      packaged.close();
    }

    const packageBytes = readFileSync(packageFile);
    const manifestBytes = readFileSync(path.join(root, "package", "history.manifest.json"));
    const repeated = runCli(root, ["history", "backup", source.databaseFile, packageFile, "--home-dir", root]);
    assert.equal(repeated.status, 1);
    assert.equal(repeated.stdout, "");
    assert.match(repeated.stderr, /History backup creation failed: HISTORY_BACKUP_DESTINATION_EXISTS:/);
    assert.deepEqual(readFileSync(packageFile), packageBytes);
    assert.deepEqual(readFileSync(path.join(root, "package", "history.manifest.json")), manifestBytes);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history export publishes a complete bundle and keeps frozen context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-export-"));
  let source;
  try {
    source = await createArchiveSource(root);
    await mkdir(path.join(root, ".codex-usage"), { recursive: true });
    await writeFile(
      path.join(root, ".codex-usage", "pricing.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        checkedAt: "2026-10-22",
        usdToCnyRate: 7.31,
        modelOverrides: {},
      })}\n`,
    );
    const destination = path.join(root, "bundle");
    const before = sourceState(source.databaseFile);

    const exported = runCli(root, ["history", "export", source.databaseFile, destination, "--home-dir", root]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /^History bundle exported\.$/m);
    assert.ok(exported.stdout.includes(`Directory: ${destination}`));
    assert.ok(exported.stdout.includes(`Manifest: ${path.join(destination, "bundle.manifest.json")}`));
    assert.ok(exported.stdout.includes(`Completion marker: ${path.join(destination, "bundle.complete.json")}`));
    assert.match(exported.stdout, /^Source database was not modified\.$/m);

    const verified = await verifyPublishedHistoryArchiveBundle(destination);
    assert.equal(verified.manifest.segments.length, 1);
    const context = await loadHistoryBackupContext(path.join(destination, "main.sqlite"));
    assert.equal(context.pricingCatalog.checkedAt, "2026-10-22");
    assert.equal(context.pricingCatalog.usdToCnyRate, 7.31);
    assert.equal(context.serviceTierEvidence.resolve(source.threadId, source.startMs), "priority");

    const main = new DatabaseSync(context.databaseFile, { readOnly: true });
    try {
      assert.deepEqual(
        main
          .prepare("SELECT session_id, total FROM events ORDER BY session_id")
          .all()
          .map((row) => ({ ...row })),
        [
          { session_id: source.threadId, total: 20 },
          { session_id: "hot-session", total: 31 },
        ],
      );
    } finally {
      main.close();
    }
    const segment = new DatabaseSync(path.join(destination, verified.manifest.segments[0].databaseFile), {
      readOnly: true,
    });
    try {
      assert.equal(segment.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
      assert.equal(segment.prepare("SELECT SUM(total) AS total FROM events").get().total, 20);
    } finally {
      segment.close();
    }
    assert.deepEqual(sourceState(source.databaseFile), before);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history export leaves an existing destination untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-export-existing-"));
  let source;
  try {
    source = await createArchiveSource(root);
    const destination = path.join(root, "existing-bundle");
    const sentinel = path.join(destination, "keep.txt");
    await mkdir(destination);
    await writeFile(sentinel, "keep");
    const before = sourceState(source.databaseFile);

    const exported = runCli(root, ["history", "export", source.databaseFile, destination, "--home-dir", root]);
    assert.equal(exported.status, 1);
    assert.equal(exported.stdout, "");
    assert.match(exported.stderr, /History bundle export failed: HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS:/);
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
    assert.equal(existsSync(path.join(destination, "bundle.complete.json")), false);
    assert.deepEqual(sourceState(source.databaseFile), before);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history export fails closed when a registered segment is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-export-missing-"));
  let source;
  try {
    source = await createArchiveSource(root);
    rmSync(source.candidateFile);
    rmSync(source.manifestFile);
    const destination = path.join(root, "bundle");
    const before = sourceState(source.databaseFile);

    const exported = runCli(root, ["history", "export", source.databaseFile, destination, "--home-dir", root]);
    assert.equal(exported.status, 1);
    assert.equal(exported.stdout, "");
    assert.match(exported.stderr, /History bundle export failed: HISTORY_ARCHIVE_SEGMENT_NOT_FOUND:/);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(sourceState(source.databaseFile), before);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history import keeps a cold segment and context usable after deleting the published package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-import-"));
  let source;
  let runtimeStore;
  try {
    source = await createArchiveSource(root, { archiveInRange: true });
    const publishedDirectory = path.join(root, "published");
    const exported = runCli(root, ["history", "export", source.databaseFile, publishedDirectory, "--home-dir", root]);
    assert.equal(exported.status, 0, exported.stderr);
    const published = await verifyPublishedHistoryArchiveBundle(publishedDirectory);

    const importDirectory = path.join(root, "imported");
    const imported = runCli(root, ["history", "import", publishedDirectory, importDirectory]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /^History bundle imported\.$/m);
    assert.ok(imported.stdout.includes(`Runtime: ${path.join(importDirectory, "runtime.sqlite")}`));
    assert.ok(imported.stdout.includes(`Bundle: ${path.join(importDirectory, "bundle")}`));
    assert.ok(imported.stdout.includes(`Import marker: ${path.join(importDirectory, "import.complete.json")}`));
    assert.match(imported.stdout, /^Online service was not switched\.$/m);

    const markerFile = path.join(importDirectory, "import.complete.json");
    const marker = JSON.parse(readFileSync(markerFile, "utf8"));
    assert.deepEqual(
      {
        formatVersion: marker.formatVersion,
        bundleManifestSha256: marker.bundleManifestSha256,
        runtimeFile: marker.runtimeFile,
      },
      {
        formatVersion: 1,
        bundleManifestSha256: published.marker.bundleManifestSha256,
        runtimeFile: "runtime.sqlite",
      },
    );
    assert.equal(new Date(marker.completedAt).toISOString(), marker.completedAt);

    await rm(publishedDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    runtimeStore = new UsageStore({
      homeDir: root,
      env: {},
      importDirs: [],
      databaseFile: path.join(importDirectory, "runtime.sqlite"),
    });
    await runtimeStore.open();
    const registry = runtimeStore.database
      .prepare("SELECT * FROM archive_segments ORDER BY segment_id")
      .all()
      .map((row) => ({ ...row }));
    assert.equal(registry.length, 1);
    const bundleDirectory = path.join(importDirectory, "bundle");
    const relativeSegmentPath = path.relative(bundleDirectory, String(registry[0].database_path));
    assert.equal(relativeSegmentPath.startsWith(".."), false);
    assert.equal(path.isAbsolute(relativeSegmentPath), false);
    assert.equal(existsSync(String(registry[0].database_path)), true);
    assert.deepEqual(
      (await runtimeStore.readHistoryArchiveEvents(String(registry[0].segment_id))).map((row) => ({
        session_id: row.session_id,
        total: row.total,
      })),
      [{ session_id: source.threadId, total: 20 }],
    );
    assert.deepEqual(
      (
        await runtimeStore.mergeHistoryArchiveEventsForRange({
          startMs: source.startMs,
          endMs: source.startMs + 61_000,
        })
      ).map((row) => ({ session_id: row.session_id, total: row.total })),
      [
        { session_id: source.threadId, total: 20 },
        { session_id: "hot-session", total: 31 },
      ],
    );
    const context = await loadHistoryBackupContext(path.join(bundleDirectory, "main.sqlite"));
    assert.equal(context.serviceTierEvidence.resolve(source.threadId, source.startMs), "priority");
  } finally {
    runtimeStore?.close();
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history import rejects draft, bad, and existing targets without overwriting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-import-gate-"));
  let source;
  try {
    source = await createArchiveSource(root);
    const publishedDirectory = path.join(root, "published");
    const exported = runCli(root, ["history", "export", source.databaseFile, publishedDirectory]);
    assert.equal(exported.status, 0, exported.stderr);
    const markerFile = path.join(publishedDirectory, "bundle.complete.json");
    const markerBytes = readFileSync(markerFile);

    rmSync(markerFile);
    const draftTarget = path.join(root, "draft-import");
    const draft = runCli(root, ["history", "import", publishedDirectory, draftTarget]);
    assert.equal(draft.status, 1);
    assert.equal(draft.stdout, "");
    assert.match(draft.stderr, /History bundle import failed: HISTORY_ARCHIVE_BUNDLE_NOT_FOUND:/);
    assert.equal(existsSync(draftTarget), false);

    writeFileSync(markerFile, "not-json");
    const badTarget = path.join(root, "bad-import");
    const bad = runCli(root, ["history", "import", publishedDirectory, badTarget]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /History bundle import failed: HISTORY_ARCHIVE_BUNDLE_BAD_MARKER:/);
    assert.equal(existsSync(badTarget), false);

    writeFileSync(markerFile, markerBytes);
    const existingEmpty = path.join(root, "existing-empty");
    const existingNonempty = path.join(root, "existing-nonempty");
    await mkdir(existingEmpty);
    await mkdir(existingNonempty);
    await writeFile(path.join(existingNonempty, "keep.txt"), "keep");
    for (const target of [existingEmpty, existingNonempty]) {
      const rejected = runCli(root, ["history", "import", publishedDirectory, target]);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /History bundle import failed: HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS:/);
    }
    assert.deepEqual(readdirSync(existingEmpty), []);
    assert.equal(readFileSync(path.join(existingNonempty, "keep.txt"), "utf8"), "keep");
    assert.equal((await verifyPublishedHistoryArchiveBundle(publishedDirectory)).ok, true);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history import removes all new output when the final marker write fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-import-marker-failure-"));
  let source;
  try {
    source = await createArchiveSource(root);
    const publishedDirectory = path.join(root, "published");
    const exported = runCli(root, ["history", "export", source.databaseFile, publishedDirectory]);
    assert.equal(exported.status, 0, exported.stderr);
    const hookFile = path.join(root, "fail-import-marker.cjs");
    writeFileSync(
      hookFile,
      `const fs = require("node:fs/promises");
const path = require("node:path");
const original = fs.writeFile;
fs.writeFile = async (file, ...args) => {
  if (path.basename(String(file)) === "import.complete.json") {
    throw Object.assign(new Error("simulated import marker write failure"), { code: "EACCES" });
  }
  return original(file, ...args);
};
require("node:module").syncBuiltinESMExports();
`,
    );
    const importDirectory = path.join(root, "failed-import");
    const imported = runCli(root, ["history", "import", publishedDirectory, importDirectory], {
      nodeArgs: ["--require", hookFile],
    });
    assert.equal(imported.status, 1);
    assert.equal(imported.stdout, "");
    assert.match(imported.stderr, /History bundle import failed: EACCES: simulated import marker write failure/);
    assert.equal(existsSync(importDirectory), false);
    assert.equal(existsSync(path.join(importDirectory, "import.complete.json")), false);
    assert.equal((await verifyPublishedHistoryArchiveBundle(publishedDirectory)).ok, true);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history archive dry-run reports the plan without changing the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-archive-"));
  let source;
  try {
    source = await createUncheckpointedSource(root);
    const sourceBytes = readFileSync(source.databaseFile);
    const sourceWalBytes = readFileSync(`${source.databaseFile}-wal`);

    const planned = runCli(root, ["history", "archive", source.databaseFile, "--dry-run"]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /^History archive dry-run\.$/m);
    assert.match(planned.stdout, /^Eligible: no$/m);
    assert.match(planned.stdout, /^Reason: below-event-threshold$/m);
    assert.match(planned.stdout, /^Events: 1$/m);
    assert.match(planned.stdout, /^Cold events: 1$/m);
    assert.match(planned.stdout, /^Cutoff local: \S.+$/m);
    assert.match(planned.stdout, /^Cutoff epoch ms: \d+$/m);

    assert.deepEqual(readFileSync(source.databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${source.databaseFile}-wal`), sourceWalBytes);

    for (const args of [
      ["history", "archive", source.databaseFile],
      ["history", "archive", source.databaseFile, "--dry-run", "extra"],
    ]) {
      const rejected = runCli(root, args);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /^Usage: codex-usage history archive <sourceDB> --dry-run$/m);
    }
    assert.deepEqual(readFileSync(source.databaseFile), sourceBytes);
    assert.deepEqual(readFileSync(`${source.databaseFile}-wal`), sourceWalBytes);
  } finally {
    source?.store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history restore creates a self-contained package without overwriting artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-cli-restore-"));
  try {
    const packageFile = await createHistoryPackage(root);
    const restored = path.join(root, "restored", "history.sqlite");
    const restoredManifest = path.join(root, "restored", "history.manifest.json");
    const restoredRun = runCli(root, ["history", "restore", packageFile, restored]);
    assert.equal(restoredRun.status, 0, restoredRun.stderr);
    assert.match(restoredRun.stdout, /^History backup restored\./);
    assert.ok(restoredRun.stdout.includes(`Database: ${restored}`));
    assert.ok(restoredRun.stdout.includes(`Manifest: ${restoredManifest}`));
    assert.match(restoredRun.stdout, /^Online service was not switched\.$/m);

    const restoredBytes = readFileSync(restored);
    const manifestText = readFileSync(restoredManifest, "utf8");
    const repeated = runCli(root, ["history", "restore", packageFile, restored]);
    assert.equal(repeated.status, 1);
    assert.equal(repeated.stdout, "");
    assert.match(repeated.stderr, /History backup restore failed: HISTORY_BACKUP_DESTINATION_EXISTS:/);
    assert.deepEqual(readFileSync(restored), restoredBytes);
    assert.equal(readFileSync(restoredManifest, "utf8"), manifestText);

    const blocked = path.join(root, "manifest-blocked.sqlite");
    const blockedManifest = path.join(root, "manifest-blocked.manifest.json");
    writeFileSync(blockedManifest, "foreign-manifest");
    const blockedRun = runCli(root, ["history", "restore", packageFile, blocked]);
    assert.equal(blockedRun.status, 1);
    assert.equal(blockedRun.stdout, "");
    assert.match(blockedRun.stderr, /History backup restore failed: HISTORY_BACKUP_DESTINATION_EXISTS:/);
    assert.equal(readFileSync(blockedManifest, "utf8"), "foreign-manifest");
    assert.equal(existsSync(blocked), false);

    rmSync(path.dirname(packageFile), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const verified = runCli(root, ["history", "verify", restored]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^History backup verified\./);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
