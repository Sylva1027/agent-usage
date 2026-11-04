import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const experimentDirectory = path.dirname(fileURLToPath(import.meta.url));
const auditModule = path.join(experimentDirectory, "startup-fs-audit.mjs");
const stateOverlayModule = path.join(experimentDirectory, "startup-state-overlay.mjs");
const projectRoot = path.resolve(experimentDirectory, "..", "..");

function runPreloaded(code, env) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(auditModule).href, "--input-type=module", "-e", code], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

async function readAudit(auditDirectory) {
  const files = (await readdir(auditDirectory)).filter((name) => name.endsWith(".ndjson"));
  assert.equal(files.length, 1);
  return (await readFile(path.join(auditDirectory, files[0]), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("preloaded audit records fs default/named, sqlite default/named, failures, dedup, and interval flush", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-fs-audit-"));
  const workspace = path.join(root, "workspace");
  const auditDirectory = path.join(root, "audit");
  const secretFile = path.join(workspace, "config.json");
  const dbDefault = path.join(workspace, "default.sqlite");
  const dbNamed = path.join(workspace, "named.sqlite");
  const missing = path.join(workspace, "missing.json");
  const secretContents = "credential-contents-must-not-be-logged";
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(secretFile, secretContents);
    const code = `
      import fs, {
        closeSync,
        createReadStream,
        open as openCallback,
        readFile as readFileCallback,
        readdir as readdirCallback,
        stat as statCallback,
      } from "node:fs";
      import fsp, {
        open as openPromise,
        readFile as readFilePromise,
        readdir as readdirPromise,
        stat as statPromise,
      } from "node:fs/promises";
      import path from "node:path";
      import sqlite, { DatabaseSync } from "node:sqlite";

      const file = process.env.AUDIT_SECRET_FILE;
      const directory = path.dirname(file);
      assert.equal(await readFilePromise(file, "utf8"), process.env.AUDIT_SECRET_CONTENTS);
      await statPromise(file);
      await statPromise(file);
      await readdirPromise(directory);
      const handle = await openPromise(file, "r");
      await handle.close();
      await new Promise((resolve, reject) => statCallback(file, error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => readdirCallback(directory, error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => readFileCallback(file, (error) => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => openCallback(file, "r", (error, fd) => {
        if (error) return reject(error);
        closeSync(fd);
        resolve();
      }));
      assert.equal(fs.readFileSync(file, "utf8"), process.env.AUDIT_SECRET_CONTENTS);
      fs.statSync(file);
      fs.readdirSync(directory);
      closeSync(fs.openSync(file, "r"));
      await new Promise((resolve, reject) => {
        const stream = createReadStream(file);
        stream.once("open", () => stream.destroy());
        stream.once("close", resolve);
        stream.once("error", reject);
      });
      await fsp.stat(process.env.AUDIT_MISSING).catch(() => {});

      for (const target of [process.env.AUDIT_DB_DEFAULT, process.env.AUDIT_DB_NAMED]) {
        const database = target.endsWith("default.sqlite") ? new sqlite.DatabaseSync(target) : new DatabaseSync(target);
        database.exec("CREATE TABLE facts (value TEXT NOT NULL) STRICT");
        database.prepare("INSERT INTO facts (value) VALUES (?)").run("audit");
        database.close();
      }
      try {
        new DatabaseSync(process.env.AUDIT_MISSING, { readOnly: true });
      } catch {}

      await new Promise(resolve => setTimeout(resolve, 320));
      const auditFile = path.join(process.env.ARCH_STARTUP_FS_AUDIT_DIR, \`startup-fs-audit-\${process.pid}.ndjson\`);
      const partial = fs.readFileSync(auditFile, "utf8");
      if (!partial.includes('"operation":"fs/promises.readFile"')) throw new Error("interval flush missing");
      process.stdout.write("audit-ok");
    `;
    const child = runPreloaded(
      `import assert from "node:assert/strict";\n${code}`,
      {
        ARCH_STARTUP_FS_AUDIT_DIR: auditDirectory,
        AUDIT_SECRET_FILE: secretFile,
        AUDIT_SECRET_CONTENTS: secretContents,
        AUDIT_DB_DEFAULT: dbDefault,
        AUDIT_DB_NAMED: dbNamed,
        AUDIT_MISSING: missing,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "audit-ok");

    const records = await readAudit(auditDirectory);
    assert.equal(records.every((record) => record.pid === child.pid), true);
    assert.equal(records.some((record) => record.path === secretFile && record.status === "ok"), true);
    assert.equal(
      records.filter(
        (record) =>
          record.path === secretFile &&
          record.operation === "fs/promises.stat" &&
          record.status === "ok",
      ).length,
      1,
    );
    assert.equal(
      records.filter(
        (record) =>
          record.path === missing &&
          record.operation === "fs/promises.stat" &&
          record.status === "error",
      ).length,
      1,
    );
    for (const operation of [
      "fs.stat",
      "fs.readdir",
      "fs.readFile",
      "fs.readFileSync",
      "fs.readdirSync",
      "fs.statSync",
      "fs/promises.stat",
      "fs/promises.readdir",
      "fs/promises.readFile",
      "fs.open",
      "fs.openSync",
      "fs/promises.open",
      "fs.createReadStream",
      "sqlite.DatabaseSync",
    ]) {
      assert.equal(records.some((record) => record.operation === operation && record.status === "ok"), true, operation);
    }
    assert.equal(records.some((record) => record.path === dbDefault && record.operation === "sqlite.DatabaseSync"), true);
    assert.equal(records.some((record) => record.path === dbNamed && record.operation === "sqlite.DatabaseSync"), true);
    assert.equal(records.some((record) => record.path === missing && record.operation === "sqlite.DatabaseSync" && record.status === "error"), true);
    assert.equal(JSON.stringify(records).includes(secretContents), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite default and named exports retain audit when state overlay is loaded after it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-fs-audit-overlay-"));
  const logicalRoot = path.join(root, "logical");
  const physicalRoot = path.join(root, "private");
  const auditDirectory = path.join(root, "audit");
  try {
    await mkdir(logicalRoot, { recursive: true });
    await mkdir(physicalRoot, { recursive: true });
    const defaultDatabase = path.join(logicalRoot, "default.sqlite");
    const namedDatabase = path.join(logicalRoot, "named.sqlite");
    const code = `
      import sqlite, { DatabaseSync } from "node:sqlite";
      for (const target of [process.env.AUDIT_DB_DEFAULT, process.env.AUDIT_DB_NAMED]) {
        const database = target.endsWith("default.sqlite") ? new sqlite.DatabaseSync(target) : new DatabaseSync(target);
        database.exec("CREATE TABLE facts (value TEXT)");
        database.close();
      }
      process.stdout.write("overlay-ok");
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(auditModule).href,
        "--import",
        pathToFileURL(stateOverlayModule).href,
        "--input-type=module",
        "-e",
        code,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          ARCH_STARTUP_FS_AUDIT_DIR: auditDirectory,
          ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot, physicalRoot }),
          AUDIT_DB_DEFAULT: defaultDatabase,
          AUDIT_DB_NAMED: namedDatabase,
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "overlay-ok");
    await assert.rejects(readFile(defaultDatabase), { code: "ENOENT" });
    await assert.rejects(readFile(namedDatabase), { code: "ENOENT" });
    assert.ok((await readFile(path.join(physicalRoot, "default.sqlite"))).length > 0);
    assert.ok((await readFile(path.join(physicalRoot, "named.sqlite"))).length > 0);

    const records = await readAudit(auditDirectory);
    for (const logicalPath of [defaultDatabase, namedDatabase]) {
      const record = records.find(
        (item) =>
          item.operation === "sqlite.DatabaseSync" &&
          item.status === "ok" &&
          item.logicalPath === logicalPath,
      );
      assert.ok(record, logicalPath);
      assert.equal(record.path.startsWith(physicalRoot), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
