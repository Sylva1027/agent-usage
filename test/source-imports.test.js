import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceImports, normalizeImportPath, scanImportSources } from "../src/source-imports.js";
import { discoverUsageSources } from "../src/usage-core.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";

const servers = new WeakMap();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-imports-"));
  const homeDir = path.join(root, "用户 空格");
  const codex = path.join(homeDir, ".codex");
  await mkdir(path.join(codex, "sessions"), { recursive: true });
  await writeFile(
    path.join(codex, "sessions", "rollout.jsonl"),
    `${[
      {
        type: "session_meta",
        timestamp: "2026-11-01T00:00:00Z",
        payload: { id: "import-test", source: "cli", originator: "codex-tui", cwd: "" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        type: "event_msg",
        timestamp: "2026-11-01T00:01:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 12, input_tokens: 8, output_tokens: 4 } },
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n")}\n`,
  );
  const options = {
    homeDir,
    env: {},
    databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    pricingRefreshSchedulerEnabled: false,
    automaticDiscoveryEnabled: false,
  };
  t.after(async () => {
    await servers.get(t)?.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, codex, options };
}

test("discovery is read-only and confirmation has an explicit empty boundary", async (t) => {
  const { codex, options } = await fixture(t);
  const imports = createSourceImports(options, async () => []);
  const scan = await imports.discover();
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].path, codex);
  await assert.rejects(stat(options.importStoreFile), { code: "ENOENT" });
  assert.deepEqual(await imports.list(), []);
  const scopes = [];
  assert.deepEqual(await discoverUsageSources({ ...options, confirmedSources: [], sourceCandidates: scopes }), []);
  assert.deepEqual(scopes, []);
  const added = await imports.add([codex]);
  assert.equal(added.selected[0].kind, "main");
  assert.equal((await imports.discover()).candidates[0].confirmed, true);
  assert.equal(
    (await discoverUsageSources({ ...options, confirmedSources: added.imports }))[0].id,
    scan.candidates[0].id,
  );
});

test("batch validation, aliases and repeated submissions preserve one source", async (t) => {
  const { root, codex, options } = await fixture(t);
  const imports = createSourceImports(options, async () => []);
  await imports.list();
  const before = await readFile(options.importStoreFile, "utf8");
  await assert.rejects(imports.add([codex, path.join(root, "missing")]), { code: "ENOENT" });
  assert.equal(await readFile(options.importStoreFile, "utf8"), before);
  const alias = path.join(root, "alias");
  await symlink(codex, alias, process.platform === "win32" ? "junction" : "dir");
  await Promise.all([imports.add([codex, alias]), imports.add([`${codex}${path.sep}`])]);
  assert.equal((await imports.list()).length, 1);
  assert.equal(JSON.parse(await readFile(options.importStoreFile, "utf8")).version, 2);
  assert.equal(normalizeImportPath('"~/.codex"', options), codex);
  assert.throws(() => normalizeImportPath("relative/path", options), { code: "INVALID_IMPORT_PATH" });
  assert.throws(() => normalizeImportPath("bad\0path", options), { code: "INVALID_IMPORT_PATH" });
});

test("app overrides are discovered but only tool-specific configuration is preconfirmed", async (t) => {
  const { root, options } = await fixture(t);
  const override = path.join(root, "custom codex");
  await mkdir(path.join(override, "sessions"), { recursive: true });
  const configured = { ...options, env: { CODEX_HOME: override } };
  assert.equal((await scanImportSources(configured)).candidates.length, 2);
  assert.deepEqual(await createSourceImports(configured, async () => []).list(), []);
  const entries = await createSourceImports({ ...configured, extraHomes: override }, async () => []).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, override);
});

test("legacy manifests are backed up and invalid manifests are never replaced", async (t) => {
  const { codex, options } = await fixture(t);
  const original = JSON.stringify({ imports: [{ path: codex }] });
  await writeFile(options.importStoreFile, original);
  const imports = createSourceImports(options, async () => []);
  const entries = await imports.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "extra");
  assert.equal(await readFile(`${options.importStoreFile}.v1-backup`, "utf8"), original);
  for (const invalid of ["{broken", JSON.stringify({ version: 3, imports: [] })]) {
    await writeFile(options.importStoreFile, invalid);
    await assert.rejects(imports.list(), { code: "INVALID_IMPORT_MANIFEST" });
    await assert.rejects(imports.add([codex]), { code: "INVALID_IMPORT_MANIFEST" });
    assert.equal(await readFile(options.importStoreFile, "utf8"), invalid);
    assert.equal(await readFile(`${options.importStoreFile}.v1-backup`, "utf8"), original);
  }
});

test("folder picker admits one request and releases it when the client leaves", async (t) => {
  const { options } = await fixture(t);
  const entered = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const server = createUsageServer({
    ...options,
    pickDirectory: ({ signal }) =>
      new Promise((resolve) => {
        entered.resolve();
        signal.addEventListener(
          "abort",
          () => {
            exited.resolve();
            resolve("");
          },
          { once: true },
        );
      }),
  });
  servers.set(t, server);
  await listenOnFetchPort(server);
  const url = `http://127.0.0.1:${server.address().port}/api/pick-directory`;
  const controller = new AbortController();
  const pending = fetch(url, { method: "POST", signal: controller.signal }).catch((error) => error);
  await entered.promise;
  const second = await fetch(url, { method: "POST" });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "DIRECTORY_PICKER_BUSY");
  controller.abort();
  await exited.promise;
  assert.equal((await pending).name, "AbortError");
});

async function listen(t, options) {
  const server = createUsageServer(options);
  await listenOnFetchPort(server);
  servers.set(t, server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, body) => {
    const response = await fetch(
      base + route,
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    );
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
}

test("fresh Web service waits for confirmation and publishes the selected version", async (t) => {
  const { codex, options } = await fixture(t);
  const get = await listen(t, options);
  const scan = await get("/api/imports/discover");
  assert.equal(scan.candidates.length, 1);
  const empty = await get("/api/usage?view=dashboard");
  assert.equal(empty.metadata.eventCount, 0);
  await get("/api/status");
  assert.equal((await get("/api/usage?freeze=1")).metadata.eventCount, 0);
  const accepted = await get("/api/imports", { paths: [codex] });
  assert.equal(accepted.importTask.status, "running");
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await get("/api/status")).importTask;
    if (task.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(task.status, "ready", JSON.stringify(task));
  const repeated = await get("/api/imports", { paths: [codex, codex] });
  assert.equal(repeated.importTask.id, task.id);
  const usage = await get("/api/usage?view=dashboard");
  assert.equal(usage.metadata.eventCount, 1);
  assert.equal(usage.sourceVersion, task.sourceVersion);
  assert.equal(usage.metadata.homes[0].kind, "main");
});

test("upgrade adopts indexed identities and leaves newly installed sources unconfirmed", async (t) => {
  const { root, codex, options } = await fixture(t);
  const store = new UsageStore(options);
  await store.sync();
  const prior = store.publishedUsageHomes();
  store.close();
  const extra = path.join(root, "later codex");
  await mkdir(path.join(extra, "sessions"), { recursive: true });
  const get = await listen(t, { ...options, env: { CODEX_HOME: extra } });
  assert.equal((await get("/api/usage?view=dashboard")).metadata.eventCount, 1);
  const saved = JSON.parse(await readFile(options.importStoreFile, "utf8")).imports;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], prior[0]);
  const scan = await get("/api/imports/discover");
  assert.equal(scan.candidates.find((entry) => entry.path === codex).confirmed, true);
  assert.equal(scan.candidates.find((entry) => entry.path === extra).confirmed, false);
});

test("migration preserves cold-only identities when their original directory is missing", async (t) => {
  const { root, codex, options } = await fixture(t);
  const store = new UsageStore(options);
  try {
    await store.sync();
    const prior = store.publishedUsageHomes();
    const segment = path.join(root, "archive.sqlite");
    await createHistoryArchiveCandidate(store.database, segment, {
      startMs: Date.parse("2026-11-01"),
      endMs: Date.parse("2026-11-02"),
    });
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segment));
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
    assert.deepEqual(store.publishedUsageHomes(), prior);
    store.close();
    await rm(codex, { recursive: true });
    const get = await listen(t, options);
    const result = await get("/api/usage?view=dashboard");
    assert.equal(result.metadata.eventCount, 1);
    assert.deepEqual(JSON.parse(await readFile(options.importStoreFile, "utf8")).imports, prior);
  } finally {
    store.close();
  }
});
