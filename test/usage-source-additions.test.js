import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { UsageStore } from "../src/usage-store.js";
import { WindowsSourceProof } from "../src/usage-source-native.js";

const helper = process.env.Q6_TEST_HELPER;
const options = { skip: process.platform !== "win32" || !helper || !existsSync(helper) };
const T = Date.parse("2026-11-05T01:00:00Z");
const normal = (file) => path.resolve(file.replace(/^\\\\\?\\/, "")).toLowerCase();
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const token = (total, ms = 1) => ({
  type: "event_msg",
  timestamp: new Date(T + ms).toISOString(),
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: total,
      },
    },
  },
});
const codexBytes = (id, total = 40) =>
  jsonl([
    {
      type: "session_meta",
      timestamp: new Date(T).toISOString(),
      payload: { id, source: "cli", originator: "codex-tui", cwd: "/work/additions", model_provider: "openai" },
    },
    { type: "turn_context", payload: { model: "gpt-5" } },
    token(total),
  ]);
const dshRow = (seq) => ({
  type: "assistant/message",
  seq,
  time: T + seq,
  data: {
    turn: 1,
    step: seq,
    usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: seq, totalTokens: 12 + seq },
    message: { content: [] },
  },
});
const frame = (rows) => zstdCompressSync(Buffer.from(jsonl(rows)));
const dshBytes = (id) =>
  frame([
    { type: "session", version: 4, id, cwd: "/work/additions", createdAt: T, delegationDepth: 0 },
    {
      type: "request/header",
      seq: 1,
      time: T + 1,
      data: { header: { config: { model: "deepseek-flash", provider: "deepseek-account" } } },
    },
    dshRow(2),
  ]);

async function fixture(t) {
  const temporary = path.join(os.homedir(), "AppData", "Local", "Temp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "usage-additions-"));
  const codex = path.join(root, ".codex", "sessions", "a.jsonl");
  const dsh = path.join(root, ".dsh", "sessions", "project", "session", "session.v4.jsonl.zstd");
  const config = { homeDir: root, env: {}, importDirs: [], databaseFile: path.join(root, "index.sqlite") };
  const stores = [];
  function create(native = true) {
    const store = new UsageStore(config);
    const proof = native ? new WindowsSourceProof(helper) : null;
    store.sourceProof.provider = async () => proof;
    store.sourceProof.close = () => proof?.close();
    store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
    stores.push(store);
    return store;
  }
  t.after(async () => {
    for (const store of stores) store.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(temporary));
    assert.ok(path.basename(root).startsWith("usage-additions-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(path.dirname(dsh), { recursive: true });
  await writeFile(codex, codexBytes("base-codex", 10));
  await writeFile(dsh, dshBytes("base-dsh"));
  const store = create();
  const native = await store.sourceProof.provider();
  assert.ok(await native.journal(root), "requires an isolated C: NTFS journal fixture");
  const added = (kind, nested = false, id = "new") =>
    kind === "codex"
      ? path.join(root, ".codex", "sessions", ...(nested ? ["2026", "11", "05"] : []), `${id}.jsonl`)
      : path.join(root, ".dsh", "sessions", nested ? "new-project" : "project", id, "session.v4.jsonl.zstd");
  async function write(kind, file, id = "new") {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, kind === "codex" ? codexBytes(id) : dshBytes(id));
  }
  return { root, codex, dsh, config, store, native, create, added, write };
}

async function initialize(store) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await store.sync({ forceFull: true });
    if (result.acquisition) return result;
  }
  assert.fail(`catalog not initialized: ${JSON.stringify(store.lastAcquisitionWork)}`);
}

const facts = (store) => ({ ...store.database.prepare("SELECT SUM(total) total, COUNT(*) count FROM events").get() });
const sourceCount = (store) => Number(store.database.prepare("SELECT COUNT(*) n FROM source_files").get().n);
const ready = (store) => store.database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get()?.ready;
const cuts = (plan) => plan.volumes.map(({ volume, journalId, nextUsn }) => ({ volume, journalId, nextUsn }));
function forbidFull(store) {
  const enumerate = store.usageFiles.bind(store);
  store.usageFiles = () => {
    throw new Error("Q9 full enumeration forbidden");
  };
  store.database.exec(`CREATE TEMP TRIGGER q9_no_catalog_wipe BEFORE DELETE ON usage_source_catalog
    WHEN OLD.path='' BEGIN SELECT RAISE(ABORT,'Q9 catalog wipe forbidden'); END`);
  return () => {
    store.usageFiles = enumerate;
    store.database.exec("DROP TRIGGER q9_no_catalog_wipe");
  };
}
async function certified(store) {
  const result = await store.sync({ certifiedOnly: true });
  assert.ok(result?.acquisition, JSON.stringify(store.lastAcquisitionWork));
  assert.equal(ready(store), 1);
  return result;
}

async function registered(f, store, file) {
  const object = await f.native.object(file);
  assert.ok(object);
  assert.equal(normal(object.path), normal(file), "normalize native lookup spelling before comparing paths");
  const rows = store.database.prepare("SELECT * FROM source_files WHERE lower(path)=?").all(normal(file));
  assert.equal(rows.length, 1, "Windows path aliases must share one source row");
  const source = rows[0];
  const home = store.homes.find((home) => home.id === source.home_id);
  assert.ok(home);
  assert.equal(source.home_path, home.path, "native spelling must not change the stored home binding");
  assert.equal(source.home_label, home.label);
  const catalog = store.database.prepare("SELECT * FROM usage_source_catalog WHERE path=?").get(normal(file));
  assert.equal(catalog?.role, "file");
  for (const key of ["volume", "id64", "id128"]) assert.equal(catalog[key], object[key], key);
  assert.equal(
    JSON.parse(catalog.payload).filePath,
    source.path,
    "catalog must reopen the exact stored source spelling",
  );
  const resolved = await f.native.resolve(f.root, object.id64);
  assert.equal(resolved?.id128, object.id128);
  assert.ok(resolved);
  assert.equal(normal(resolved.path), normal(file));
}

async function agreesWithRaw(f, store = f.store) {
  const oracle = new UsageStore({ ...f.config, databaseFile: path.join(f.root, "oracle.sqlite") });
  oracle.sourceProof.provider = async () => null;
  oracle.repositoryResolver = store.repositoryResolver;
  try {
    await oracle.sync({ forceFull: true });
    for (const table of ["events", "rate_limit_observations", "quota_usage_sources", "source_files"]) {
      const rows = (index) =>
        index.database
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => {
            const { id: _id, indexed_at: _indexedAt, ...fact } = row;
            // Windows native paths are lower-case; the raw scanner retains directory-entry spelling.
            for (const key of ["path", "source_path"]) if (fact[key]) fact[key] = normal(fact[key]);
            return JSON.stringify(fact);
          })
          .sort();
      assert.deepEqual(rows(store), rows(oracle), `${table} must agree with an independent raw full sync`);
    }
  } finally {
    oracle.close();
  }
}

async function reopenQuiet(f, count) {
  const expected = facts(f.store),
    fingerprint = f.store.fingerprint,
    generatedAt = f.store.generatedAt;
  f.store.close();
  const reopened = f.create();
  await reopened.open();
  forbidFull(reopened);
  const before = reopened.database.prepare("SELECT total_changes() n").get().n;
  const checked = await reopened.checkSources(f.config);
  assert.ok(checked?.acquisition, JSON.stringify(reopened.lastAcquisitionWork));
  assert.equal(checked.fingerprint, fingerprint);
  assert.equal(checked.generatedAt, generatedAt);
  assert.equal(checked.fileCount, count);
  assert.equal(reopened.database.prepare("SELECT total_changes() n").get().n, before, "quiet reopen must not write");
  assert.equal((await certified(reopened)).updatedFileCount, 0);
  assert.equal(reopened.lastAcquisitionWork.selectedFiles, 0);
  assert.equal(sourceCount(reopened), count);
  assert.deepEqual(facts(reopened), expected);
}

for (const kind of ["codex", "dsh"])
  for (const nested of [false, true]) {
    test(
      `${kind} registers a new source in ${nested ? "new nested directories" : "an existing directory"} without a full scan`,
      options,
      async (t) => {
        const f = await fixture(t),
          file = f.added(kind, nested);
        if (!nested) await mkdir(path.dirname(file), { recursive: true });
        const original = await initialize(f.store);
        assert.deepEqual(facts(f.store), { total: 24, count: 2 });
        const restore = forbidFull(f.store);
        await f.write(kind, file);
        const result = await certified(f.store);
        assert.equal(result.fileCount, original.fileCount + 1);
        assert.equal(result.updatedFileCount, 1);
        assert.equal(f.store.lastAcquisitionWork.selectedFiles, 1);
        assert.equal(sourceCount(f.store), 3);
        assert.deepEqual(facts(f.store), { total: kind === "codex" ? 64 : 38, count: 3 });
        await registered(f, f.store, file);
        if (nested) {
          for (
            let dir = path.dirname(file);
            normal(dir) !== normal(path.join(f.root, kind === "codex" ? ".codex" : ".dsh", "sessions"));
            dir = path.dirname(dir)
          )
            assert.equal(
              f.store.database.prepare("SELECT role FROM usage_source_catalog WHERE path=?").get(normal(dir))?.role,
              "directory",
            );
        }
        // A registered source must subsequently append using its saved spelling, without a duplicate row.
        await appendFile(file, kind === "codex" ? jsonl([token(50, 2)]) : frame([dshRow(3)]));
        assert.equal((await certified(f.store)).fileCount, 3);
        assert.equal(f.store.lastSyncSourceWork.appendedFiles, 1);
        assert.equal(sourceCount(f.store), 3);
        assert.deepEqual(facts(f.store), { total: kind === "codex" ? 74 : 53, count: 4 });
        restore();
        await agreesWithRaw(f);
        await reopenQuiet(f, 3);
      },
    );
  }

test(
  "a new source plus an ongoing append publishes one fixed cut and leaves later writes pending",
  options,
  async (t) => {
    const f = await fixture(t),
      file = f.added("codex");
    await initialize(f.store);
    forbidFull(f.store);
    await f.write("codex", file);
    await appendFile(f.codex, jsonl([token(20, 2)]));
    const acquisition = f.store.sourceAcquisition;
    const prepare = acquisition.prepare.bind(acquisition),
      capture = acquisition.capture.bind(acquisition);
    let capturedCut,
      injected = false;
    acquisition.prepare = async (...args) => {
      const plan = await prepare(...args);
      if (plan) capturedCut = cuts(plan);
      return plan;
    };
    acquisition.capture = async (selected, native, bootstrap) => {
      const result = await capture(selected, native, bootstrap);
      if (!bootstrap && !injected) {
        injected = true;
        await appendFile(f.codex, jsonl([token(30, 3)]));
      }
      return result;
    };
    const first = await certified(f.store);
    assert.ok(injected);
    assert.deepEqual(first.acquisition.cuts, capturedCut);
    assert.deepEqual(facts(f.store), { total: 74, count: 4 });
    acquisition.prepare = prepare;
    acquisition.capture = capture;
    await certified(f.store);
    assert.deepEqual(facts(f.store), { total: 84, count: 5 });
    assert.equal(sourceCount(f.store), 3);
    await agreesWithRaw(f);
  },
);

test(
  "directories and files created after the captured directory cut stay visible next round or fall back safely",
  options,
  async (t) => {
    const f = await fixture(t);
    await initialize(f.store);
    const first = f.added("codex"),
      lateCodex = f.added("codex", true, "late"),
      lateDsh = f.added("dsh", true, "late");
    await f.write("codex", first);
    const changes = f.native.changes.bind(f.native);
    let injected = false,
      directoryCut;
    f.native.changes = async (...args) => {
      const interval = await changes(...args);
      if (interval && !injected) {
        injected = true;
        directoryCut = interval.nextUsn;
        await f.write("codex", lateCodex, "late-codex");
        await f.write("dsh", lateDsh, "late-dsh");
      }
      return interval;
    };
    const result = await f.store.sync({ certifiedOnly: true });
    f.native.changes = changes;
    assert.ok(injected);
    if (result?.acquisition && sourceCount(f.store) === 3)
      assert.equal(
        result.acquisition.cuts[0].nextUsn,
        directoryCut,
        "do not acknowledge a later namespace cut without importing it",
      );
    if (!(await f.store.sync({ certifiedOnly: true }))) await initialize(f.store);
    assert.deepEqual(facts(f.store), { total: 118, count: 5 });
    assert.equal(sourceCount(f.store), 5);
    await agreesWithRaw(f);
    await reopenQuiet(f, 5);
  },
);

test(
  "zero-byte Codex and DSH creations can finish later without omissions or duplicate registration",
  options,
  async (t) => {
    const f = await fixture(t);
    const files = [f.added("codex"), f.added("dsh")];
    for (const file of files) await mkdir(path.dirname(file), { recursive: true });
    await initialize(f.store);
    for (const file of files) await writeFile(file, "");
    try {
      await f.store.sync({ certifiedOnly: true });
    } catch (error) {
      assert.match(error.message, /无法解压 DSH 会话日志/);
      assert.equal(ready(f.store), 0, "an unfinished frame must not certify partial completion");
    }
    assert.deepEqual(facts(f.store), { total: 24, count: 2 });
    await f.write("codex", files[0]);
    await f.write("dsh", files[1]);
    if (!(await f.store.sync({ certifiedOnly: true }))) await initialize(f.store);
    assert.deepEqual(facts(f.store), { total: 78, count: 4 });
    assert.equal(sourceCount(f.store), 4);
    await agreesWithRaw(f);
    await reopenQuiet(f, 4);
  },
);

test(
  "rename, deletion, hardlink, reparse, temporary, compressed and other-harness additions remain safe",
  options,
  async (t) => {
    for (const scenario of ["rename", "delete", "hardlink", "reparse", "temporary", "compressed", "other-harness"]) {
      const f = await fixture(t);
      const claude = path.join(f.root, ".claude", "projects", "project", "base.jsonl");
      const claudeRow = (id) => ({
        type: "assistant",
        uuid: id,
        timestamp: new Date(T).toISOString(),
        sessionId: id,
        cwd: "/work/additions",
        message: {
          id,
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      if (scenario === "other-harness") {
        await mkdir(path.dirname(claude), { recursive: true });
        await writeFile(claude, jsonl([claudeRow("claude-base")]));
      }
      await initialize(f.store);
      const before = facts(f.store),
        count = sourceCount(f.store);
      if (scenario === "rename") await rename(f.codex, `${f.codex}.gone`);
      if (scenario === "delete") await rm(f.codex);
      if (scenario === "hardlink") await link(f.codex, f.added("codex"));
      if (scenario === "reparse") {
        const target = path.join(f.root, "junction-target");
        await mkdir(target);
        await writeFile(path.join(target, "hidden.jsonl"), codexBytes("hidden"));
        await symlink(target, path.join(path.dirname(f.codex), "junction"), "junction");
      }
      if (scenario === "temporary") {
        await f.write("codex", path.join(path.dirname(f.codex), ".tmp", "hidden.jsonl"));
        await f.write("dsh", path.join(f.root, ".dsh", "sessions", ".tmp", "hidden", "session.v4.jsonl.zstd"));
      }
      if (scenario === "compressed")
        await writeFile(`${f.added("codex")}.zst`, zstdCompressSync(Buffer.from(codexBytes("compressed"))));
      if (scenario === "other-harness")
        await writeFile(path.join(path.dirname(claude), "new.jsonl"), jsonl([claudeRow("claude-new")]));
      const restore = forbidFull(f.store);
      const result = await f.store.sync({ certifiedOnly: true });
      if (scenario === "temporary" && result?.acquisition) {
        assert.equal(result.fileCount, count);
        assert.deepEqual(facts(f.store), before, "ignored temporary trees cannot become usage sources");
      } else assert.equal(result, null, `${scenario}: ${JSON.stringify(f.store.lastAcquisitionWork)}`);
      restore();
      if (["hardlink", "reparse"].includes(scenario)) continue;
      const full = await f.store.sync({ forceFull: true });
      if (["rename", "delete"].includes(scenario)) {
        assert.deepEqual(facts(f.store), before, `${scenario} retains missing history`);
        assert.ok(full.missingSources.some((source) => normal(source.path) === normal(f.codex)));
      } else await agreesWithRaw(f);
    }
  },
);

test(
  "external database mutation rejects a ready catalog before and during addition publication",
  options,
  async (t) => {
    for (const stage of ["before-prepare", "after-prepare"]) {
      const f = await fixture(t);
      await initialize(f.store);
      await f.write("codex", f.added("codex"));
      const mutate = () => {
        const writer = new DatabaseSync(f.config.databaseFile);
        try {
          writer.prepare("UPDATE source_files SET size=-1 WHERE path=?").run(f.codex);
        } finally {
          writer.close();
        }
      };
      const acquisition = f.store.sourceAcquisition,
        prepare = acquisition.prepare.bind(acquisition);
      if (stage === "before-prepare") mutate();
      else
        acquisition.prepare = async (...args) => {
          const plan = await prepare(...args);
          mutate();
          return plan;
        };
      const restore = forbidFull(f.store);
      try {
        assert.equal(await f.store.sync({ certifiedOnly: true }), null, stage);
      } catch (error) {
        assert.match(error.message, /Q9 full enumeration forbidden/, stage);
      }
      assert.equal(ready(f.store), 0, stage);
      assert.equal(acquisition.state(f.config), null, stage);
      acquisition.prepare = prepare;
      restore();
      await initialize(f.store);
      assert.equal(sourceCount(f.store), 3);
      await agreesWithRaw(f);
    }
  },
);

test("replacing a newly resolved file identity cannot publish a ready catalog", options, async (t) => {
  const f = await fixture(t),
    file = f.added("codex");
  await initialize(f.store);
  await f.write("codex", file);
  const acquisition = f.store.sourceAcquisition,
    capture = acquisition.capture.bind(acquisition);
  let replaced = false;
  acquisition.capture = async (selected, native, bootstrap) => {
    if (normal(selected.filePath) === normal(file) && !replaced) {
      replaced = true;
      await rename(file, path.join(f.root, "old-inode.jsonl"));
      await writeFile(file, codexBytes("replacement", 70));
    }
    return capture(selected, native, bootstrap);
  };
  const restore = forbidFull(f.store);
  try {
    assert.equal(await f.store.sync({ certifiedOnly: true }), null);
  } catch (error) {
    assert.match(error.message, /Q9 full enumeration forbidden/);
  }
  assert.ok(replaced);
  assert.equal(ready(f.store), 0);
  acquisition.capture = capture;
  restore();
  await initialize(f.store);
  assert.deepEqual(facts(f.store), { total: 94, count: 3 });
  await agreesWithRaw(f);
});

test(
  "partial addition commits and interrupted publication recover after restart without omissions",
  options,
  async (t) => {
    for (const stage of ["first-source", "before-publication"]) {
      const f = await fixture(t),
        codex = f.added("codex", true),
        dsh = f.added("dsh", true);
      await initialize(f.store);
      await f.write("codex", codex);
      await f.write("dsh", dsh);
      const restore = forbidFull(f.store);
      if (stage === "first-source") {
        const replace = f.store.replaceFile.bind(f.store);
        f.store.replaceFile = async (...args) => {
          await replace(...args);
          throw new Error("Q9 interruption after first source commit");
        };
      } else
        f.store.sourceAcquisition.complete = async () => {
          throw new Error("Q9 interruption before publication");
        };
      await assert.rejects(f.store.sync({ certifiedOnly: true }), /Q9 interruption/, stage);
      assert.equal(sourceCount(f.store), stage === "first-source" ? 3 : 4, stage);
      assert.equal(ready(f.store), 0, stage);
      const newDirectories = f.store.database
        .prepare("SELECT path FROM usage_source_catalog WHERE role='directory'")
        .all();
      assert.ok(
        !newDirectories.some((row) => normal(row.path) === normal(path.dirname(codex))),
        "unpublished directory identities must not survive",
      );
      restore();
      f.store.close();
      const reopened = f.create();
      await reopened.open();
      const allowFull = forbidFull(reopened);
      assert.equal(await reopened.sync({ certifiedOnly: true }), null, stage);
      allowFull();
      await initialize(reopened);
      assert.deepEqual(facts(reopened), { total: 78, count: 4 }, stage);
      assert.equal(sourceCount(reopened), 4, stage);
      await agreesWithRaw(f, reopened);
      forbidFull(reopened);
      assert.equal((await certified(reopened)).updatedFileCount, 0, stage);
    }
  },
);
