import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureStartupInputs, inventoryStartupInputs } from "./startup-inputs.mjs";
import { UsageStore } from "../../src/usage-store.js";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(experimentDirectory, "..", "..");
const stateOverlayModule = path.join(experimentDirectory, "startup-state-overlay.mjs");
const replayModule = path.join(experimentDirectory, "startup-replay.mjs");
const auditModule = path.join(experimentDirectory, "startup-fs-audit.mjs");

function disabledSources() {
  return {
    CODEX_USAGE_ZCODE: "0",
    CODEX_USAGE_DSH: "0",
    CODEX_USAGE_OPENCODE: "0",
    CODEX_USAGE_CLAUDE: "0",
    CODEX_USAGE_WORKBUDDY: "0",
  };
}

function spawnReplay(code, env) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(stateOverlayModule).href,
      "--import",
      pathToFileURL(replayModule).href,
      "--import",
      pathToFileURL(auditModule).href,
      "--input-type=module",
      "-e",
      code,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
}

test("replay maps captured files and sqlite, freezes listings, and reports fallbacks without touching sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-replay-"));
  const logicalRoot = path.join(root, "logical-home");
  const physicalRoot = path.join(root, "private-state");
  const captureRoot = path.join(root, "capture-output");
  const auditDirectory = path.join(root, "audit");
  const sessionsDirectory = path.join(logicalRoot, ".codex", "sessions", "project");
  const logFile = path.join(sessionsDirectory, "session.jsonl");
  const settingsFile = path.join(logicalRoot, ".codex", "settings.json");
  const auxiliaryDirectory = path.join(logicalRoot, ".codex", "aux-parent");
  const configFile = path.join(logicalRoot, ".codex", "config.toml");
  const databaseFile = path.join(logicalRoot, ".codex", "usage.sqlite");
  const liveNewLog = path.join(sessionsDirectory, "live-new.jsonl");
  const missingWal = `${logFile}-wal`;
  const appModuleFile = path.join(logicalRoot, "app-module.js");
  const replayStoreFile = path.join(root, "replay-parity.sqlite");
  let databaseWriter = null;
  try {
    await mkdir(sessionsDirectory, { recursive: true });
    await mkdir(auxiliaryDirectory, { recursive: true });
    await writeFile(logFile, '{"captured":true}\n');
    await writeFile(settingsFile, '{"source":"not-captured"}\n');
    await writeFile(configFile, "model = 'captured'\n");

    databaseWriter = new DatabaseSync(databaseFile);
    databaseWriter.exec("PRAGMA journal_mode = WAL; CREATE TABLE facts (value TEXT NOT NULL) STRICT;");
    databaseWriter.prepare("INSERT INTO facts (value) VALUES (?)").run("captured-wal-row");

    const inventory = await inventoryStartupInputs({
      outputDirectory: path.join(root, "inventory"),
      options: {
        homeDir: logicalRoot,
        env: disabledSources(),
        importDirs: [],
        importStoreFile: path.join(root, "missing-imports.json"),
        activeIndexFile: path.join(root, "missing-index.sqlite"),
      },
    });
    const capture = await captureStartupInputs(inventory.manifest, {
      outputDirectory: captureRoot,
      extraFiles: [
        { path: configFile, role: "config" },
        { path: databaseFile, role: "database" },
      ],
    });
    assert.equal(capture.summary.failureCount, 0);

    const logEntry = capture.manifest.files.find((file) => file.logicalPath === logFile);
    const dbEntry = capture.manifest.files.find((file) => file.logicalPath === databaseFile);
    assert.ok(logEntry);
    assert.ok(dbEntry?.sidecarsBefore?.wal);

    const realStoreOptions = {
      homeDir: logicalRoot,
      databaseFile: path.join(root, "real-parity.sqlite"),
      env: disabledSources(),
      importDirs: [],
    };
    const realStore = new UsageStore(realStoreOptions);
    let realFingerprint;
    try {
      await realStore.sync(realStoreOptions);
      const fingerprints = JSON.parse(
        realStore.database
          .prepare("SELECT value FROM store_meta WHERE key = 'usage_file_fingerprints'")
          .get().value,
      );
      realFingerprint = fingerprints[logFile];
    } finally {
      realStore.close();
    }
    assert.match(realFingerprint, /^\d+:\d+(?:\.\d+)?:[\da-f]{64}$/);

    await writeFile(logFile, '{"captured":true}\n{"live":"must-not-be-read"}\n');
    await writeFile(liveNewLog, '{"live":"must-stay-invisible"}\n');
    await mkdir(path.join(physicalRoot, ".codex", "aux-parent"), { recursive: true });
    await writeFile(path.join(physicalRoot, ".codex", "settings.json"), '{"private":"fallback"}\n');
    await writeFile(path.join(physicalRoot, ".codex", "aux-parent", "evidence.txt"), "private evidence");
    await writeFile(path.join(physicalRoot, "app-module.js"), "export const fallback = true;\n");

    const augmentedManifest = JSON.parse(await readFile(capture.manifestFile, "utf8"));
    augmentedManifest.missingPaths = [liveNewLog, missingWal];
    augmentedManifest.directoryStats = {
      [sessionsDirectory]: {
        size: 777,
        mtimeMs: 1793600000123.4,
        atimeMs: 1793600000100.4,
        ctimeMs: 1793600000123.4,
        birthtimeMs: 1793600000000.4,
        mode: 0o40755,
        dev: "1",
        ino: "2",
        nlink: 1,
      },
    };
    await writeFile(capture.manifestFile, `${JSON.stringify(augmentedManifest, null, 2)}\n`);

    const sourceBeforeReplay = {
      log: await stat(logFile),
      logBytes: await readFile(logFile),
      settingsBytes: await readFile(settingsFile),
      database: await stat(databaseFile),
      databaseBytes: await readFile(databaseFile),
      wal: await stat(`${databaseFile}-wal`),
      walBytes: await readFile(`${databaseFile}-wal`),
    };
    const expected = {
      logSize: logEntry.sourceBefore.size,
      logMtimeMs: logEntry.sourceBefore.mtimeMs,
      walSize: dbEntry.sidecarsBefore.wal.size,
      walMtimeMs: dbEntry.sidecarsBefore.wal.mtimeMs,
      realFingerprint,
    };
    const code = `
      import assert from "node:assert/strict";
      import fs, { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
      import fsp, { readFile, readdir, realpath, stat } from "node:fs/promises";
      import path from "node:path";
      import { DatabaseSync } from "node:sqlite";
      const { UsageStore } = await import(process.env.REPLAY_USAGE_STORE);

      const log = process.env.REPLAY_LOG;
      const settings = process.env.REPLAY_SETTINGS;
      const aux = process.env.REPLAY_AUX;
      const databaseFile = process.env.REPLAY_DATABASE;
      const expected = JSON.parse(process.env.REPLAY_EXPECTED);
      const info = await stat(log);
      assert.equal(info.size, expected.logSize);
      assert.equal(info.mtimeMs, expected.logMtimeMs);
      assert.equal(lstatSync(log).size, expected.logSize);
      assert.equal(readFileSync(log, "utf8"), '{"captured":true}\\n');
      assert.equal(await readFile(log, "utf8"), '{"captured":true}\\n');
      assert.equal(await realpath(log), log);
      assert.equal(realpathSync(log), log);
      const frozenDirectory = await stat(path.dirname(log));
      assert.equal(frozenDirectory.isDirectory(), true);
      assert.equal(frozenDirectory.size, 777);
      assert.equal(frozenDirectory.mtimeMs, 1793600000123.4);
      const entries = await readdir(path.dirname(log));
      assert.deepEqual(entries, ["session.jsonl"]);
      const streamed = [];
      for await (const chunk of createReadStream(log, { encoding: "utf8" })) streamed.push(chunk);
      assert.equal(streamed.join(""), '{"captured":true}\\n');
      let uncapturedError;
      try {
        await readFile(settings, "utf8");
      } catch (error) {
        uncapturedError = error;
      }
      assert.equal(uncapturedError?.code, "ENOENT");
      assert.equal(await readFile(process.env.REPLAY_APP_MODULE, "utf8"), "export const fallback = true;\\n");
      assert.deepEqual(await readdir(aux), ["evidence.txt"]);

      let missingError;
      try {
        await readFile(process.env.REPLAY_LIVE_NEW, "utf8");
      } catch (error) {
        missingError = error;
      }
      assert.equal(missingError?.code, "ENOENT");
      assert.equal(fs.statSync(process.env.REPLAY_LIVE_NEW, { throwIfNoEntry: false }), undefined);
      assert.equal(fs.statSync(process.env.REPLAY_MISSING_WAL, { throwIfNoEntry: false }), undefined);
      await assert.rejects(stat(process.env.REPLAY_MISSING_WAL), { code: "ENOENT" });
      await assert.rejects(fsp.writeFile(log, "mutated"), { code: "EACCES" });

      const walInfo = await stat(databaseFile + "-wal");
      assert.equal(walInfo.size, expected.walSize);
      assert.equal(walInfo.mtimeMs, expected.walMtimeMs);
      const defaultDatabase = new (await import("node:sqlite")).DatabaseSync(databaseFile);
      try {
        assert.equal(defaultDatabase.prepare("SELECT value FROM facts").get().value, "captured-wal-row");
        assert.throws(() => defaultDatabase.exec("INSERT INTO facts VALUES ('write')"), /readonly/i);
      } finally {
        defaultDatabase.close();
      }
      const namedDatabase = new DatabaseSync(databaseFile);
      try {
        assert.equal(namedDatabase.prepare("SELECT value FROM facts").get().value, "captured-wal-row");
      } finally {
        namedDatabase.close();
      }

      const replayStoreOptions = {
        homeDir: process.env.REPLAY_LOGICAL,
        databaseFile: process.env.REPLAY_STORE_DB,
        env: JSON.parse(process.env.REPLAY_SOURCE_ENV),
        importDirs: [],
      };
      const replayStore = new UsageStore(replayStoreOptions);
      try {
        await replayStore.sync(replayStoreOptions);
        const fingerprints = JSON.parse(
          replayStore.database
            .prepare("SELECT value FROM store_meta WHERE key = 'usage_file_fingerprints'")
            .get().value,
        );
        assert.equal(fingerprints[log], expected.realFingerprint);
      } finally {
        replayStore.close();
      }

      fs.mkdirSync(path.join(process.env.REPLAY_LOGICAL, ".codex-usage"), { recursive: true });
      const privateDatabase = new DatabaseSync(path.join(process.env.REPLAY_LOGICAL, ".codex-usage", "state.sqlite"));
      privateDatabase.exec("CREATE TABLE state (value TEXT)");
      privateDatabase.close();
      process.stdout.write("replay-ok");
    `;
    const child = spawnReplay(code, {
      ...disabledSources(),
      ARCH_STARTUP_REPLAY_FILE: capture.manifestFile,
      ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot, physicalRoot }),
      ARCH_STARTUP_FS_AUDIT_DIR: auditDirectory,
      REPLAY_LOG: logFile,
      REPLAY_SETTINGS: settingsFile,
      REPLAY_APP_MODULE: appModuleFile,
      REPLAY_AUX: auxiliaryDirectory,
      REPLAY_DATABASE: databaseFile,
      REPLAY_LIVE_NEW: liveNewLog,
      REPLAY_MISSING_WAL: missingWal,
      REPLAY_LOGICAL: logicalRoot,
      REPLAY_SOURCE_ENV: JSON.stringify(disabledSources()),
      REPLAY_STORE_DB: replayStoreFile,
      REPLAY_USAGE_STORE: pathToFileURL(path.join(projectRoot, "src", "usage-store.js")).href,
      REPLAY_EXPECTED: JSON.stringify(expected),
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "replay-ok");

    await assert.rejects(readFile(path.join(logicalRoot, ".codex-usage", "state.sqlite")), { code: "ENOENT" });
    assert.ok((await stat(path.join(physicalRoot, ".codex-usage", "state.sqlite"))).size > 0);

    const report = JSON.parse(await readFile(path.join(capture.manifest.captureDirectory, `replay-${child.pid}.json`), "utf8"));
    assert.equal(report.pid, child.pid);
    assert.equal(
      report.records.some((record) => record.kind === "uncapturedRead" && record.path === settingsFile),
      true,
    );
    assert.equal(report.records.some((record) => record.kind === "directoryFallback" && record.path === auxiliaryDirectory), true);
    assert.equal(
      report.records.some((record) => record.kind === "manifestMissing" && record.path === liveNewLog),
      true,
    );
    assert.equal(report.records.some((record) => record.kind === "deniedWrite" && record.path === logFile), true);

    assert.deepEqual(await readFile(logFile), sourceBeforeReplay.logBytes);
    assert.deepEqual(await readFile(settingsFile), sourceBeforeReplay.settingsBytes);
    assert.equal((await stat(logFile)).size, sourceBeforeReplay.log.size);
    assert.equal((await stat(logFile)).mtimeMs, sourceBeforeReplay.log.mtimeMs);
    assert.deepEqual(await readFile(databaseFile), sourceBeforeReplay.databaseBytes);
    assert.equal((await stat(databaseFile)).size, sourceBeforeReplay.database.size);
    assert.equal((await stat(databaseFile)).mtimeMs, sourceBeforeReplay.database.mtimeMs);
    assert.deepEqual(await readFile(`${databaseFile}-wal`), sourceBeforeReplay.walBytes);
    assert.equal((await stat(`${databaseFile}-wal`)).size, sourceBeforeReplay.wal.size);
    assert.equal((await stat(`${databaseFile}-wal`)).mtimeMs, sourceBeforeReplay.wal.mtimeMs);
    assert.equal((await readFile(liveNewLog, "utf8")).includes("must-stay-invisible"), true);
  } finally {
    databaseWriter?.close();
    await rm(root, { recursive: true, force: true });
  }
});
