import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createZstdCompress, zstdCompressSync } from "node:zlib";
import { UsageStore } from "../src/usage-store.js";
import { WindowsSourceProof } from "../src/usage-source-native.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { UsageSourceAcquisition } from "../src/usage-source-acquisition.js";
import { createUsageIntegrationFixture } from "../test-support/usage-fixture.mjs";
import { streamDshSessionEvents } from "../src/dsh-usage.js";
import { readZstdFrameBoundary } from "../src/dsh-frame-progress.js";

const helper = process.env.Q6_TEST_HELPER;
const options = { skip: process.platform !== "win32" || !helper || !existsSync(helper) };
const T = Date.parse("2026-11-05T01:00:00Z");
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const usage = (total) => ({ input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
const token = (total, ms = 1) => ({ type: "event_msg", timestamp: new Date(T + ms).toISOString(), payload: {
  type: "token_count", info: { total_token_usage: usage(total) } } });
const header = (id) => [{ type: "session_meta", timestamp: new Date(T).toISOString(),
  payload: { id, source: "cli", originator: "codex-tui", cwd: "/work/acquisition", model_provider: "openai" } },
{ type: "turn_context", payload: { model: "gpt-5" } }];
const dshRow = (seq) => ({ type: "assistant/message", seq, time: T + seq,
  data: { turn: 1, step: seq, usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0,
    outputTokens: seq, totalTokens: 12 + seq }, message: { content: [] } } });
const frame = (rows) => zstdCompressSync(Buffer.from(jsonl(rows)));

async function largeDshFrame() {
  const rows = [{ type: "session", version: 4, id: "session", cwd: "/work/acquisition", createdAt: T, delegationDepth: 0 },
    { type: "request/header", seq: 1, time: T + 1, data: { header: { config: { model: "deepseek-flash", provider: "deepseek-account" } } } },
    { ...dshRow(2), padding: "x".repeat(2 * 1024 * 1024) }];
  const chunks = [], compressor = createZstdCompress();
  const done = new Promise((resolve, reject) => { compressor.on("end", resolve); compressor.on("error", reject); });
  compressor.on("data", (chunk) => chunks.push(chunk));
  compressor.end(jsonl(rows));
  await done;
  const bytes = Buffer.concat(chunks);
  const boundary = await readZstdFrameBoundary((offset, length) => bytes.subarray(offset, offset + length), 0, bytes.length);
  assert.equal(boundary.contentSize, null, "regression needs the real unknown-size frame shape");
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-acquisition-"));
  const codex = path.join(root, ".codex", "sessions", "a.jsonl");
  const dsh = path.join(root, ".dsh", "sessions", "project", "session", "session.v4.jsonl.zstd");
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(path.dirname(dsh), { recursive: true });
  await writeFile(codex, jsonl([...header("a"), token(10)]));
  await writeFile(dsh, frame([{ type: "session", version: 4, id: "session", cwd: "/work/acquisition", createdAt: T, delegationDepth: 0 },
    { type: "request/header", seq: 1, time: T + 1, data: { header: { config: { model: "deepseek-flash", provider: "deepseek-account" } } } }, dshRow(2)]));
  const config = { homeDir: root, env: {}, importDirs: [], databaseFile: path.join(root, "index.sqlite") };
  const stores = [];
  function create() {
    const store = new UsageStore(config);
    const native = new WindowsSourceProof(helper);
    store.sourceProof.provider = async () => native;
    store.sourceProof.close = () => native.close();
    store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
    stores.push(store);
    return store;
  }
  t.after(async () => {
    for (const store of stores) store.close();
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(root).startsWith("usage-acquisition-"));
    await rm(root, { recursive: true, force: true });
  });
  const store = create();
  const native = await store.sourceProof.provider();
  const journal = await native.journal(root);
  assert.ok(journal, "this native integration requires the isolated C: journal fixture");
  return { root, codex, dsh, config, store, create, native };
}

async function initialize(store) {
  let result;
  for (let i = 0; i < 3; i++) {
    result = await store.sync({ forceFull: true });
    if (result.acquisition) return result;
  }
  assert.fail(`catalog not initialized: ${JSON.stringify(store.lastAcquisitionWork)}`);
}

const facts = (store) => store.database.prepare("SELECT SUM(total) n, COUNT(*) count FROM events").get();

test("a restart checks an unchanged published cut without committing or hiding later writes", options, async (t) => {
  const f = await fixture(t);
  const original = await initialize(f.store);
  const originalFacts = { ...facts(f.store) };
  const generatedAt = f.store.generatedAt;
  f.store.close();
  const reopened = f.create(); await reopened.open();
  const changes = () => Number(reopened.database.prepare("SELECT total_changes() n").get().n);
  const before = changes();
  const checked = await reopened.checkSources(f.config);
  assert.ok(checked?.acquisition);
  assert.equal(checked.fingerprint, original.fingerprint);
  assert.equal(checked.generatedAt, generatedAt);
  assert.equal(changes(), before, "startup verification must not invalidate the saved publication");
  assert.deepEqual({ ...facts(reopened) }, originalFacts);
  await appendFile(f.codex, jsonl([token(20, 2)]));
  assert.equal(await reopened.checkSources(f.config), null);
  assert.deepEqual({ ...facts(reopened) }, originalFacts);
  assert.ok((await reopened.sync({ certifiedOnly: true }))?.acquisition);
  assert.equal(Number(facts(reopened).n), Number(originalFacts.n) + 10);
});

test("startup verification rejects an external commit or auxiliary change during its check", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  const acquisition = f.store.sourceAcquisition;
  const prepare = acquisition.prepare.bind(acquisition);
  acquisition.prepare = async (...args) => {
    const plan = await prepare(...args);
    const writer = new DatabaseSync(f.config.databaseFile);
    writer.exec("UPDATE events SET total=777 WHERE id=(SELECT MIN(id) FROM events)");
    writer.close();
    return plan;
  };
  assert.equal(await f.store.checkSources(f.config), null);
  acquisition.prepare = prepare;
  await initialize(f.store);
  acquisition.prepare = async (...args) => {
    const plan = await prepare(...args);
    await writeFile(path.join(f.root, ".codex", "config.toml"), 'model="gpt-5"');
    return plan;
  };
  assert.equal(await f.store.checkSources(f.config), null);
});

test("unchanged checks checkpoint journal capacity without regenerating the published data", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  const originalFacts = { ...facts(f.store) }, generatedAt = f.store.generatedAt;
  const acquisition = f.store.sourceAcquisition, prepare = acquisition.prepare.bind(acquisition);
  acquisition.prepare = async (...args) => {
    const plan = await prepare(...args);
    acquisition.work.records = 1024;
    return plan;
  };
  const checked = await f.store.checkSources(f.config);
  assert.ok(checked?.acquisition);
  const saved = acquisition.state(f.config);
  assert.deepEqual(saved.volumes.map(({ volume, journalId, nextUsn }) => ({ volume, journalId, nextUsn })), checked.acquisition.cuts);
  assert.equal(f.store.readMetaRaw("generated_at"), generatedAt);
  assert.deepEqual({ ...facts(f.store) }, originalFacts);
  acquisition.prepare = prepare;
  await appendFile(f.codex, jsonl([token(20, 2)]));
  assert.equal(await f.store.checkSources(f.config), null);
  await f.store.sync();
  assert.equal(Number(facts(f.store).n), Number(originalFacts.n) + 10);
});

test("native acquisition resumes open writers and reopens durably without resolving unrelated volume objects", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  f.store.usageFiles = () => { throw new Error("full enumeration forbidden on certified path"); };
  const before = facts(f.store);
  const writer = await open(f.codex, "a");
  try {
    for (let i = 1; i <= 3; i++) {
      await writer.write(jsonl([token(10 + i * 10, i + 1)]));
      await writer.sync();
      const result = await f.store.sync({ certifiedOnly: true });
      assert.ok(result?.acquisition, JSON.stringify({ i, result, work: f.store.lastAcquisitionWork,
        currentWork: f.store.sourceAcquisition.work }));
      assert.equal(f.store.lastAcquisitionWork.selectedFiles, 1);
      assert.equal(f.store.lastSyncSourceWork.appendedFiles, 1);
      assert.equal(f.store.lastSyncSourceWork.prefixBytesRead, 0);
      assert.equal(facts(f.store).n, Number(before.n) + i * 10);
    }
  } finally { await writer.close(); }
  await appendFile(f.dsh, frame([dshRow(3)]));
  assert.ok((await f.store.sync({ certifiedOnly: true }))?.acquisition);
  assert.equal(f.store.lastSyncSourceWork.appendedFiles, 1);
  const after = { ...facts(f.store) };
  f.store.close();
  const reopened = f.create();
  reopened.usageFiles = () => { throw new Error("reopen enumeration forbidden"); };
  const result = await reopened.sync({ certifiedOnly: true });
  assert.ok(result?.acquisition, JSON.stringify(reopened.lastAcquisitionWork));
  assert.equal(reopened.lastAcquisitionWork.selectedFiles, 0);
  assert.deepEqual({ ...facts(reopened) }, after);
});

test("native directory inventory includes empty nested directories and detects new source files there", options, async (t) => {
  const f = await fixture(t);
  const empty = path.join(path.dirname(f.codex), "empty", "nested");
  await mkdir(empty, { recursive: true });
  await initialize(f.store);
  assert.equal(f.store.database.prepare("SELECT role FROM usage_source_catalog WHERE path=?").get(empty.toLowerCase())?.role, "directory");
  const before = Number(facts(f.store).n);
  f.store.usageFiles = () => { throw new Error("new source must not enumerate historical files"); };
  await writeFile(path.join(empty, "new.jsonl"), jsonl([...header("new-file"), token(40)]));
  const result = await f.store.sync({ certifiedOnly: true });
  assert.ok(result?.acquisition, JSON.stringify(f.store.lastAcquisitionWork));
  assert.equal(result.fileCount, 3);
  assert.equal(Number(facts(f.store).n), before + 40);
  assert.ok((await f.store.sync({ certifiedOnly: true }))?.acquisition);
});

test("native acquisition refuses namespace changes and retains missing history on full fallback", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  const before = { ...facts(f.store) };
  await rename(f.codex, `${f.codex}.gone`);
  assert.equal(await f.store.sync({ certifiedOnly: true }), null);
  assert.equal(f.store.sourceAcquisition.state(f.config)?.fingerprint, f.store.fingerprint);
  const result = await f.store.sync();
  assert.deepEqual({ ...facts(f.store) }, before);
  assert.ok(result.missingSources.some((source) => source.path === f.codex));
});

test("external fact writes and source aliases revoke catalog authorization", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  const db = new DatabaseSync(f.config.databaseFile);
  db.exec("UPDATE events SET total=123 WHERE id=(SELECT MIN(id) FROM events)");
  db.close();
  assert.equal(await f.store.sync({ certifiedOnly: true }), null);
  await appendFile(f.codex, jsonl([token(20, 2)]));
  await initialize(f.store);
  await link(f.codex, path.join(f.root, "alias.jsonl"));
  assert.equal(await f.store.sync({ certifiedOnly: true }), null);
});

test("certified publication binds auxiliary inputs and checks external commits without source discovery", options, async (t) => {
  const f = await fixture(t);
  const status = await initialize(f.store);
  const cache = new UsageSummaryCache(f.config);
  try {
    const source = await cache.readCertifiedSourceState(f.config, status);
    assert.ok(source?.publication);
    await writeFile(path.join(f.root, ".codex", "config.toml"), 'model = "gpt-5"');
    assert.equal(await cache.readCertifiedSourceState(f.config, status), null);
    assert.equal(await f.store.sync({ certifiedOnly: true }), null);
  } finally { cache.close(); }
});

test("bootstrap repairs a captured interval once and leaves writes during repair for the next round", options, async (t) => {
  const f = await fixture(t);
  await f.store.open();
  const acquisition = new UsageSourceAcquisition(f.store);
  f.store.sourceAcquisition = acquisition;
  const capture = acquisition.capture.bind(acquisition);
  let first = false, later = false;
  acquisition.capture = async (file, native, bootstrap) => {
    const result = await capture(file, native, bootstrap);
    if (file.filePath === f.codex && bootstrap && !first) {
      first = true;
      await appendFile(f.codex, jsonl([token(20, 2)]));
    } else if (file.filePath === f.codex && !bootstrap && !later) {
      later = true;
      await appendFile(f.codex, jsonl([token(30, 3)]));
    }
    return result;
  };
  const initial = await f.store.sync({ forceFull: true });
  assert.ok(initial.acquisition, JSON.stringify(acquisition.work));
  assert.ok(first && later);
  assert.equal(facts(f.store).n, 34);
  const firstCut = initial.acquisition.cuts[0].nextUsn;
  f.store.usageFiles = () => { throw new Error("full enumeration forbidden"); };
  const next = await f.store.sync({ certifiedOnly: true });
  assert.ok(next.acquisition);
  assert.equal(facts(f.store).n, 44);
  assert.ok(BigInt(next.acquisition.cuts[0].nextUsn) >= BigInt(firstCut));
});

test("growth before the bootstrap seal is repaired without acknowledging unparsed bytes", options, async (t) => {
  const f = await fixture(t);
  await f.store.open();
  const acquisition = new UsageSourceAcquisition(f.store);
  f.store.sourceAcquisition = acquisition;
  const capture = acquisition.capture.bind(acquisition);
  let appended = false;
  acquisition.capture = async (file, native, bootstrap) => {
    if (bootstrap && file.filePath === f.codex && !appended) {
      appended = true;
      await appendFile(f.codex, jsonl([token(20, 2)]));
    }
    return capture(file, native, bootstrap);
  };
  const result = await f.store.sync({ forceFull: true });
  assert.ok(result.acquisition, JSON.stringify(acquisition.work));
  assert.equal(facts(f.store).n, 34);
  assert.equal((await f.store.sync({ certifiedOnly: true })).updatedFileCount, 0);
});

test("an affected later source is repaired through the persistent dependency queue", options, async (t) => {
  const f = await fixture(t);
  const laterFile = path.join(path.dirname(f.codex), "later.jsonl");
  await writeFile(laterFile, jsonl([...header("a"), token(100, 10)]));
  await initialize(f.store);
  const before = Number(facts(f.store).n);
  const text = jsonl([...header("a"), token(20)]);
  await writeFile(f.codex, text);
  f.store.usageFiles = () => { throw new Error("full enumeration forbidden"); };
  const result = await f.store.sync({ certifiedOnly: true });
  assert.ok(result?.acquisition);
  assert.equal(f.store.lastSyncSourceWork.replacedFiles, 2);
  assert.equal(facts(f.store).n, before);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM usage_source_reparse").get().n, 0);
});

test("a prepublication interruption replays committed facts without double counting", options, async (t) => {
  const f = await fixture(t);
  await initialize(f.store);
  const initial = Number(facts(f.store).n);
  await appendFile(f.codex, jsonl([token(20, 2)]));
  const complete = f.store.sourceAcquisition.complete.bind(f.store.sourceAcquisition);
  f.store.sourceAcquisition.complete = async () => { throw new Error("fixture interruption before cursor publication"); };
  await assert.rejects(f.store.sync({ certifiedOnly: true }), /fixture interruption/);
  assert.equal(facts(f.store).n, initial + 10);
  assert.equal(f.store.database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 0);
  f.store.sourceAcquisition.complete = complete;
  f.store.close();
  const reopened = f.create();
  assert.equal(await reopened.sync({ certifiedOnly: true }), null);
  await initialize(reopened);
  assert.equal(facts(reopened).n, initial + 10);
});

test("six harnesses share one coverage boundary; another harness change uses the complete fallback", options, async (t) => {
  const f = await fixture(t);
  const other = createUsageIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  t.after(() => other.close());
  f.config.extraZcodeHomes = other.reportOptions.extraZcodeHomes;
  f.config.extraOpencodeHomes = other.reportOptions.extraOpencodeHomes;
  const claude = path.join(f.root, ".claude", "projects", "project", "session.jsonl");
  const buddy = path.join(f.root, ".workbuddy-ai", "projects", "project", "session.jsonl");
  for (const file of [claude, buddy]) await mkdir(path.dirname(file), { recursive: true });
  const claudeRow = { type: "assistant", uuid: "claude-a", timestamp: new Date(T).toISOString(),
    sessionId: "claude", cwd: "/work/acquisition", message: { id: "claude-a", model: "claude-sonnet-4-5",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  await writeFile(claude, jsonl([claudeRow]));
  await writeFile(buddy, jsonl([{ type: "function_call", id: "buddy-a", timestamp: T,
    sessionId: "buddy", cwd: "/work/acquisition", providerData: { messageId: "buddy-a", model: "deepseek-flash",
      usage: { requests: 1, inputTokens: 10, outputTokens: 3, totalTokens: 13 } } }]));
  await initialize(f.store);
  assert.equal(new Set(f.store.homes.map((home) => home.kind)).size, 6);
  const before = Number(facts(f.store).n);
  const enumerate = f.store.usageFiles.bind(f.store);
  f.store.usageFiles = () => { throw new Error("unchanged harnesses must not be enumerated"); };
  await appendFile(f.codex, jsonl([token(20, 2)]));
  assert.ok((await f.store.sync({ certifiedOnly: true }))?.acquisition, JSON.stringify(f.store.lastAcquisitionWork));
  assert.equal(facts(f.store).n, before + 10);
  await appendFile(claude, jsonl([{ ...claudeRow, uuid: "claude-b", message: { ...claudeRow.message, id: "claude-b" } }]));
  assert.equal(await f.store.sync({ certifiedOnly: true }), null);
  f.store.usageFiles = enumerate;
  await f.store.sync();
  assert.equal(facts(f.store).n, before + 22);
  const oracle = new UsageStore({ ...f.config, databaseFile: path.join(f.root, "oracle.sqlite") });
  oracle.sourceProof.provider = async () => null;
  oracle.repositoryResolver = f.store.repositoryResolver;
  try {
    await oracle.sync();
    for (const table of ["events", "rate_limit_observations", "quota_usage_sources"]) {
      const rows = (store) => store.database.prepare(`SELECT * FROM ${table}`).all().map((row) => {
        const { id: _id, ...fact } = row;
        return JSON.stringify(fact);
      }).sort();
      assert.deepEqual(rows(f.store), rows(oracle), `${table} agrees with a complete raw-source rebuild`);
    }
    const filters = { preset: "all", calendarZone: "utc", now: new Date(T + 86400000) };
    const actual = await f.store.dashboardHistory(filters, { includeDetails: false });
    const expected = await oracle.dashboardHistory(filters, { includeDetails: false });
    const { generatedAt: _actualTime, ...actualSummary } = actual.summary;
    const { generatedAt: _expectedTime, ...expectedSummary } = expected.summary;
    assert.deepEqual(actualSummary, expectedSummary);
    assert.deepEqual(actual.periodComparison, expected.periodComparison);
  } finally { oracle.close(); }
});

test("a legitimate large DSH frame keeps a full-only capability while other files append", options, async (t) => {
  const f = await fixture(t);
  await writeFile(f.dsh, await largeDshFrame());
  await assert.rejects(streamDshSessionEvents(f.dsh, { id: "fixture", path: f.root }, () => {}, { onProgress() {} }),
    { code: "SOURCE_PROGRESS_UNSUPPORTED" });
  await initialize(f.store);
  const mode = () => JSON.parse(f.store.database.prepare("SELECT payload FROM usage_source_catalog WHERE path=?").get(f.dsh.toLowerCase()).payload);
  assert.equal(mode().readMode, "full");
  assert.equal(mode().supported, true);
  assert.equal(f.store.database.prepare("SELECT 1 FROM usage_source_progress WHERE source_path=?").get(f.dsh), undefined);
  const before = Number(facts(f.store).n);
  f.store.usageFiles = () => { throw new Error("full enumeration forbidden"); };
  const replace = f.store.replaceFile.bind(f.store);
  let fullReads = 0;
  f.store.replaceFile = (file, callbacks) => {
    if (file.filePath === f.dsh) { assert.equal(callbacks.progress, false); fullReads++; }
    return replace(file, callbacks);
  };
  await appendFile(f.codex, jsonl([token(20, 2)]));
  assert.ok((await f.store.sync({ certifiedOnly: true }))?.acquisition, JSON.stringify(f.store.lastAcquisitionWork));
  assert.equal(fullReads, 0);
  await appendFile(f.dsh, frame([dshRow(3)]));
  assert.ok((await f.store.sync({ certifiedOnly: true }))?.acquisition, JSON.stringify(f.store.lastAcquisitionWork));
  assert.equal(fullReads, 1);
  assert.equal(f.store.lastAcquisitionWork.selectedFiles, 1);
  assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
  assert.equal(facts(f.store).n, before + 25);
  assert.equal(mode().readMode, "full");
  assert.equal(mode().covered, true, "complete parsing must retain its actual native read interval");
  assert.equal((await f.store.sync({ certifiedOnly: true })).updatedFileCount, 0);
  const oracle = new UsageStore({ ...f.config, databaseFile: path.join(f.root, "full-oracle.sqlite") });
  oracle.sourceProof.provider = async () => null;
  oracle.repositoryResolver = f.store.repositoryResolver;
  try {
    await oracle.sync();
    const events = (store) => store.database.prepare("SELECT * FROM events").all().map(({ id: _id, ...row }) => JSON.stringify(row)).sort();
    assert.deepEqual(events(f.store), events(oracle));
  } finally { oracle.close(); }
});

test("initializing old full-only facts repairs writes before sealing and leaves later writes pending", options, async (t) => {
  const f = await fixture(t);
  await writeFile(f.dsh, await largeDshFrame());
  f.store.sourceProof.provider = async () => null;
  await f.store.sync();
  f.store.close();
  const nativeStore = f.create();
  await nativeStore.open();
  const acquisition = new UsageSourceAcquisition(nativeStore);
  nativeStore.sourceAcquisition = acquisition;
  const capture = acquisition.capture.bind(acquisition);
  let beforeSeal = false, duringRepair = false;
  acquisition.capture = async (file, native, bootstrap) => {
    if (bootstrap && file.filePath === f.dsh && !beforeSeal) {
      beforeSeal = true; await appendFile(f.dsh, frame([dshRow(3)]));
    }
    const value = await capture(file, native, bootstrap);
    if (!bootstrap && file.filePath === f.dsh && !duringRepair) {
      duringRepair = true; await appendFile(f.dsh, frame([dshRow(4)]));
    }
    return value;
  };
  assert.ok((await nativeStore.sync({ forceFull: true })).acquisition, JSON.stringify(acquisition.work));
  assert.ok(beforeSeal && duringRepair);
  assert.equal(facts(nativeStore).n, 39);
  nativeStore.usageFiles = () => { throw new Error("full enumeration forbidden"); };
  assert.ok((await nativeStore.sync({ certifiedOnly: true }))?.acquisition);
  assert.equal(facts(nativeStore).n, 55);
});

test("a full-only source change during parsing rolls back its facts and completion", options, async (t) => {
  const f = await fixture(t);
  await writeFile(f.dsh, await largeDshFrame());
  await initialize(f.store);
  const before = { ...facts(f.store) };
  await appendFile(f.dsh, frame([dshRow(3)]));
  const capture = f.store.sourceProof.capture.bind(f.store.sourceProof);
  let changed = false;
  f.store.sourceProof.capture = async (...args) => {
    if (args[0] === f.dsh && !changed) { changed = true; await appendFile(f.dsh, frame([dshRow(4)])); }
    return capture(...args);
  };
  await assert.rejects(f.store.sync({ certifiedOnly: true }), { code: "LIVE_SOURCE_CHANGED" });
  assert.ok(changed);
  assert.deepEqual({ ...facts(f.store) }, before);
  assert.equal(f.store.database.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get().ready, 0);
  f.store.sourceProof.capture = capture;
  await initialize(f.store);
  assert.equal(facts(f.store).n, 55);
});
