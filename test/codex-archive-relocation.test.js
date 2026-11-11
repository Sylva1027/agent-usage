import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { UsageStore } from "../src/usage-store.js";
import { UsageSourceProof } from "../src/usage-source-proof.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createUsageServer } from "../src/server.js";

const name = "rollout-2026-11-03T04-00-00-01a129b1-990c-7be1-8cc3-d4540a76594a.jsonl";
const usage = total => ({ total_tokens: total, input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
function text(totals) {
  return `${[
    { type: "session_meta", payload: { id: "archive-relocation", cwd: "/work", source: "cli" } },
    { type: "turn_context", payload: { model: "gpt-5.1-codex" } },
    ...totals.map((total, i) => ({ type: "event_msg", timestamp: `2026-11-03T04:0${i + 1}:00.000Z`, payload: {
      type: "token_count", info: { total_token_usage: usage(total), last_token_usage: usage(total - (totals[i - 1] || 0)) },
      rate_limits: { limit_id: "codex", primary: { used_percent: i + 1, window_minutes: 300, resets_at: 1793678400 } },
    } })),
  ].map(row => JSON.stringify(row)).join("\n")}\n`;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archive-relocation-"));
  const home = path.join(root, ".codex");
  const oldPath = path.join(home, "sessions", "2026", "11", "03", name);
  const archive = path.join(home, "archived_sessions");
  await mkdir(path.dirname(oldPath), { recursive: true });
  await mkdir(archive, { recursive: true });
  await writeFile(oldPath, text([100, 200]));
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile: path.join(root, "facts.sqlite") });
  const proof = new UsageSourceProof();
  proof.provider = async () => null;
  store.sourceProof = proof;
  store.repositoryResolver = cwd => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.sync({ forceFull: true });
  store.database.exec("DELETE FROM usage_source_progress; DELETE FROM usage_source_baselines");
  const source = store.database.prepare("SELECT * FROM source_files WHERE path=?").get(oldPath);
  return { store, oldPath, archive, file: async filePath => ({ filePath, info: await stat(filePath), source: {
    id: source.home_id, kind: source.kind, label: source.home_label, path: source.home_path,
  } }) };
}

for (const compressed of [false, true]) {
  test(`legacy Codex archive move${compressed ? " with compression" : ""} preserves history and adds only new usage`, async t => {
    const { store, oldPath, archive } = await fixture(t);
    store.database.prepare("UPDATE events SET price_version='old-local-catalog' WHERE source_path=?").run(oldPath);
    const next = path.join(archive, name + (compressed ? ".zst" : ""));
    await writeFile(next, compressed ? zstdCompressSync(Buffer.from(text([100, 200, 250]))) : text([100, 200, 250]));
    await rm(oldPath);
    await store.sync({ forceFull: true });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 250);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM rate_limit_observations").get().n, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_source_reparse").get().n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM history_replaced_facts WHERE source_path=? AND fact_table='events'").get(oldPath).n, 2);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM source_files WHERE path=?").get(oldPath).n, 0);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
    store.close();
    await store.sync({ forceFull: true });
    assert.equal(store.summarize({ preset: "all" }).totals.total, 250);
  });
}

test("archive relocation repairs duplicates committed by an earlier failed sync", async t => {
  const { store, oldPath, archive, file } = await fixture(t);
  const next = path.join(archive, name);
  await writeFile(next, text([100, 200, 250]));
  await rm(oldPath);
  await store.replaceFile(await file(next));
  assert.ok(store.database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(oldPath));
  await store.sync({ forceFull: true });
  assert.equal(store.summarize({ preset: "all" }).totals.total, 250);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 3);
});

for (const mismatch of ["usage", "quota"]) {
  test(`archive ${mismatch} mismatch rolls back instead of deleting retained facts`, async t => {
    const { store, oldPath, archive, file } = await fixture(t);
    const before = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    const quota = store.database.prepare("SELECT * FROM rate_limit_observations").all();
    const next = path.join(archive, name);
    const contents = mismatch === "usage" ? text([100]) : (await readFile(oldPath, "utf8")).replace('"used_percent":1', '"used_percent":9');
    await writeFile(next, contents);
    await rm(oldPath);
    await assert.rejects(store.replaceFile({ ...await file(next), relocatedFrom: oldPath }), { code: "SOURCE_RELOCATION_MISMATCH" });
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), before);
    assert.deepEqual(store.database.prepare("SELECT * FROM rate_limit_observations").all(), quota);
    assert.equal(store.database.isTransaction, false);
  });
}

test("a relocated child can be reparsed again after a later-discovered parent changes", async t => {
  const { store, oldPath, archive } = await fixture(t);
  const childName = name.replace("d4540a76594a", "d4540a76594b");
  const child = path.join(path.dirname(oldPath), childName);
  const childText = text([300]).replace("04:01:00.000Z", "04:03:00.000Z");
  await writeFile(child, childText);
  await store.sync({ forceFull: true });
  assert.equal(store.summarize({ preset: "all" }).totals.total, 300);
  const next = path.join(archive, childName);
  await writeFile(next, childText);
  await rm(child);
  await writeFile(oldPath, text([100, 200, 250]).replace("04:03:00.000Z", "04:02:30.000Z"));
  const original = store.usageFiles.bind(store);
  store.usageFiles = async homes => {
    const result = await original(homes);
    result.files.sort((a, b) => Number(b.filePath === next) - Number(a.filePath === next));
    return result;
  };
  await store.sync({ forceFull: true });
  assert.equal(store.summarize({ preset: "all" }).totals.total, 300);
  assert.equal(store.database.prepare("SELECT total FROM events WHERE source_path=?").get(next).total, 50);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_source_reparse").get().n, 0);
});

test("a restarted executor opens for repair without publishing incomplete metadata", async t => {
  const { store, oldPath } = await fixture(t);
  const options = { ...store.options, databaseFile: store.databaseFile };
  const contents = await readFile(oldPath);
  store.database.prepare("INSERT INTO usage_source_reparse VALUES (?)").run(oldPath);
  store.close();
  await rm(oldPath);
  const executor = createUsageExecutor(options, { idleTimeoutMs: 60_000 });
  t.after(() => executor.close());
  await executor.open();
  await assert.rejects(executor.sync({ options }), { code: "SOURCE_DEPENDENCY_PENDING" });
  await writeFile(oldPath, contents);
  await executor.sync({ options });
  await executor.close();
  await store.open();
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_source_reparse").get().n, 0);
  assert.equal(store.summarize({ preset: "all" }).totals.total, 200);
});

test("the original HTTP path repairs an interrupted archive move after restart", async t => {
  const { store, oldPath, archive, file } = await fixture(t);
  const next = path.join(archive, name);
  await writeFile(next, text([100, 200, 250]));
  await rm(oldPath);
  await store.replaceFile(await file(next));
  const options = { ...store.options, databaseFile: store.databaseFile, watchSources: false };
  store.close();
  const server = createUsageServer(options);
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage?preset=all&view=dashboard`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.summary.totals.total, 250);
  } finally {
    await server.close();
  }
});
