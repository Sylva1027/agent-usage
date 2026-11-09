import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../../src/history-archive.js";
import { compactHistoryArchivePackage } from "../../src/history-archive-compaction.js";
import { UsageStore } from "../../src/usage-store.js";
import { DAY, datasetOptions } from "./c1-datasets.mjs";
import { archiveRequestPrepare, assertArchiveRequestStartup } from "./archive-request-prepare.mjs";

const json = async file => JSON.parse(await readFile(file, "utf8"));
async function write(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}
const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex");

async function fixture(t, beforeCleanup = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-request-tiny-"));
  t.after(async () => { await beforeCleanup(); await rm(root, { recursive: true, force: true }); });
  const inventoryFile = path.join(root, "output/windows-parallel-20261109/cleanup/main-retained-sqlite.json");
  const inventory = { format: 1, complete: true, databases: [] }, specs = {};
  for (const [label, days] of [["current", 49], ["year", 365], ["two-years", 730]]) {
    const datasetRoot = path.join(root, "output/c1-long-history-20261107/datasets", label);
    const seed = path.join(datasetRoot, "seed-state/usage-index.sqlite");
    // Invalid SQLite proves dry mode only reads metadata and stats files.
    await write(seed, "not a database"); await write(`${seed}-wal`, "tiny WAL");
    await write(path.join(datasetRoot, "dataset.json"), "not read by the recovery tool");
    await write(path.join(datasetRoot, "seed-state/pricing-auto.json"), { fixture: true });
    const startMs = Date.parse("2024-11-01T00:00:00Z"), endMs = startMs + days * DAY;
    const mapping = { format: 1, databaseFile: path.join(root, "output/archive-compaction-20261108/upgrades", label, "state/usage-index.sqlite"), packages: [] };
    const proof = { label, passed: true, verification: { passed: true, counts: { minimum: startMs + 1, maximum: endMs - 1 } }, packages: [] };
    for (let start = startMs, i = 0; start < endMs - 30 * DAY; start += 90 * DAY, i++) {
      const databaseFile = path.join(root, "output/archive-compaction-20261108", label === "two-years" && i === 0
        ? "stage-a/segment-0.sqlite" : `packages/${label}/segment-${i}/segment-${i}.sqlite`);
      await write(databaseFile, "tiny sealed placeholder");
      const next = { segment_id: String(i + 1).padStart(64, "0"), database_sha256: String(i + 1).padStart(64, "0"),
        database_path: databaseFile, start_ms: start, end_ms: Math.min(start + 90 * DAY, endMs - 30 * DAY), event_count: 1 };
      mapping.packages.push({ previous: { ...next, database_path: "deleted-original.sqlite" }, next });
      proof.packages.push({ startMs: next.start_ms, endMs: next.end_ms, eventCount: 1 });
      await write(databaseFile.replace(/\.sqlite$/, ".manifest.json"), { formatVersion: 1,
        database: { filename: path.basename(databaseFile), bytes: (await stat(databaseFile)).size, sha256: next.database_sha256 }, tables: { events: { rows: 1 } } });
      inventory.databases.push({ path: databaseFile });
    }
    proof.verification.counts.events = mapping.packages.length + 1;
    const mappingFile = path.join(root, "output/archive-compaction-20261108/upgrades", label, "maintenance/compaction.json");
    const proofFile = path.join(datasetRoot, "capacity-proof.json");
    await write(mappingFile, mapping); await write(proofFile, proof);
    inventory.databases.push({ path: seed });
    specs[label] = { seed, datasetRoot, mappingFile, mapping, proofFile, proof, startMs, endMs };
  }
  await write(inventoryFile, inventory);
  return { root, inventoryFile, specs, output: path.join(root, "output/archive-request-lifetime-20261110/fixtures") };
}

test("dry plans 1/4/8 retained packages, follows stage-a, and never opens or copies SQLite", async t => {
  const f = await fixture(t), before = await digest(f.specs.year.seed);
  const receipt = await archiveRequestPrepare({ root: f.root });
  assert.equal(receipt.mode, "dry"); assert.equal(receipt.prepared, false);
  assert.deepEqual(receipt.datasets.map(row => row.packages.length), [1, 4, 8]);
  assert.match(receipt.datasets[2].packages[0].databaseFile, /stage-a/);
  assert.equal(receipt.packageCopyBytes, 0); assert.equal(receipt.rawCopyBytes, 0);
  assert.equal(receipt.copyBytes, receipt.datasets.flatMap(row => row.copies).reduce((sum, row) => sum + row.bytes, 0));
  assert.ok(receipt.datasets.every(row => row.copies.some(copy => copy.source.endsWith("-wal"))));
  assert.equal(await digest(f.specs.year.seed), before);
  await assert.rejects(access(f.output), { code: "ENOENT" });
  assert.ok(receipt.metadata.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
});

test("prepare uses product commits in private copies, conserves retained facts and WAL-only events", async t => {
  let seed;
  const f = await fixture(t, () => seed?.close()), spec = f.specs.year;
  await rm(spec.seed); await rm(`${spec.seed}-wal`);
  const home = path.join(spec.datasetRoot, "home"), options = datasetOptions(home, path.dirname(spec.seed));
  seed = new UsageStore(options);
  await seed.open();
  const source = path.join(home, ".codex/sessions/rollout-tiny.jsonl");
  const coldEnd = spec.endMs - 30 * DAY;
  const timestamps = [spec.startMs, ...spec.proof.packages.slice(1).map(row => row.startMs), coldEnd - 1, coldEnd, spec.endMs - 1];
  const usage = n => ({ total_tokens: 15 * n, input_tokens: 10 * n, cached_input_tokens: 2 * n, output_tokens: 5 * n, reasoning_output_tokens: n });
  await write(source, [JSON.stringify({ timestamp: new Date(spec.startMs).toISOString(), type: "session_meta", payload: { id: "tiny", cwd: "/workspace/tiny", source: "cli" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
    ...timestamps.map((timestamp, i) => JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: "event_msg", payload: {
      type: "token_count", info: { total_token_usage: usage(i + 1), last_token_usage: usage(1) } } })), ""].join("\n"));
  await seed.sync({ options, forceFull: true });
  assert.equal(seed.database.prepare("SELECT COUNT(*) n FROM events").get().n, 7);
  seed.database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0");
  seed.database.prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)").run(path.join(home, "missing-raw.jsonl"), "codex", "retained", "Retained", home, 1, 1, "frozen");
  seed.database.prepare(`INSERT INTO history_replaced_facts VALUES('events','codex','home',?,'kept',1,'{}','Home',?,'events.v1','reparse','frozen')`).run(source, spec.datasetRoot);
  for (const [i, entry] of spec.mapping.packages.entries()) {
    const original = path.join(f.root, `original-${i}.sqlite`), file = entry.next.database_path;
    await createHistoryArchiveCandidate(seed.database, original, { startMs: entry.next.start_ms, endMs: entry.next.end_ms });
    await rm(file); await rm(file.replace(/\.sqlite$/, ".manifest.json"));
    await compactHistoryArchivePackage(original, file);
    const manifest = await json(file.replace(/\.sqlite$/, ".manifest.json"));
    entry.next.segment_id = entry.next.database_sha256 = manifest.database.sha256;
    entry.next.event_count = manifest.tables.events.rows;
    entry.previous = { ...entry.next, database_path: original };
    spec.proof.packages[i].eventCount = entry.next.event_count;
  }
  spec.proof.verification.counts.events = 7;
  await write(spec.mappingFile, spec.mapping); await write(spec.proofFile, spec.proof);
  // Same raw bytes, changed mtime: prep must use the real parser/progress path to normalize its private state.
  const rawBytes = await digest(source);
  await utimes(source, new Date(), new Date(Date.now() + 2000));
  const rawStat = await stat(source, { bigint: true });
  const protectedFiles = [spec.seed, `${spec.seed}-wal`, `${spec.seed}-shm`, f.specs["two-years"].mapping.databaseFile, source,
    ...spec.mapping.packages.flatMap(({ next }) => [next.database_path, next.database_path.replace(/\.sqlite$/, ".manifest.json")])];
  await write(protectedFiles[3], "unique two-year primary must remain untouched");
  const hashes = await Promise.all(protectedFiles.map(digest));
  t.mock.method(UsageStore.prototype, "sync", () => assert.fail("layout recovery must leave source sync to the real gateway"));
  t.mock.method(UsageStore.prototype, "dashboardHistory", () => assert.fail("layout recovery must not materialize legacy history"));
  const receipt = await archiveRequestPrepare({ mode: "prepare", label: "year", root: f.root });
  assert.equal(receipt.prepared, true);
  assert.equal(receipt.datasets[0].result.hotEvents, 2);
  assert.deepEqual(receipt.datasets[0].result.commits.map(row => row.deletedEventCount), [1, 1, 1, 2]);
  assert.equal(receipt.datasets[0].result.retainedFacts.tables.source_files.rows, 2);
  assert.equal(receipt.datasets[0].result.retainedFacts.tables.history_replaced_facts.rows, 1);
  const normalization = receipt.datasets[0].result.normalization;
  assert.equal(normalization.required, true);
  assert.equal(normalization.via, "original gateway before timing");
  assert.equal(normalization.formalStartupGuardRequired, true);
  const config = await json(receipt.datasets[0].configFile), restored = new UsageStore(config.options);
  try {
    await restored.open();
    const visible = await restored.publishedHistoryUsageEvents();
    assert.equal(visible.length, 7); assert.equal(visible.reduce((sum, row) => sum + row.total.total, 0), 105);
    assert.deepEqual(JSON.parse(restored.readMetaRaw("history_archive_event_authority")).segmentIds,
      spec.mapping.packages.map(row => row.next.segment_id).sort());
    assert.deepEqual(restored.database.prepare("SELECT timestamp_ms FROM events ORDER BY timestamp_ms").all().map(row => row.timestamp_ms), [coldEnd, spec.endMs - 1]);
    assert.equal((await restored.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(restored.database, spec.mapping.packages[0].next.database_path))).replay, true);
  } finally { restored.close(); }
  assert.deepEqual(await Promise.all(protectedFiles.map(digest)), hashes);
  assert.equal(await digest(source), rawBytes);
  assert.equal((await stat(source, { bigint: true })).mtimeNs, rawStat.mtimeNs);
  assert.equal((await stat(source, { bigint: true })).ino, rawStat.ino);
  assert.equal((await json(receipt.receiptFile)).prepared, true);
  assert.ok(!(await readdir(config.state)).includes("home"));
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "year", root: f.root }), /already exists/);
  await assert.rejects(access(path.join(config.state, "home")), { code: "ENOENT" });

  seed.database.prepare("UPDATE events SET total=total+1 WHERE timestamp_ms=?").run(spec.startMs);
  const changedSeed = await digest(`${spec.seed}-wal`), mismatch = path.join(path.dirname(f.output), "mismatch");
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "year", root: f.root, output: mismatch }),
    error => error.code === "HISTORY_ARCHIVE_SOURCE_CHANGED");
  const failed = await json(path.join(mismatch, "receipt.json"));
  assert.equal(failed.prepared, false);
  const rejected = new UsageStore(failed.datasets[0].config.options);
  try {
    await rejected.open();
    assert.equal(rejected.database.prepare("SELECT COUNT(*) n FROM events").get().n, 7);
    assert.equal(rejected.database.prepare("SELECT COUNT(*) n FROM archive_segments").get().n, 0);
  } finally { rejected.close(); }
  assert.equal(await digest(`${spec.seed}-wal`), changedSeed);
  await assert.rejects(access(failed.datasets[0].configFile), { code: "ENOENT" });
});

test("formal startup gate requires real complete no-op source checks and rejects unequal work", () => {
  const start = { event: "sync-start", instance: "executor", syncId: "sync-1", certifiedOnly: false };
  const round = { event: "round-end", instance: "executor", syncId: "sync-1", updatedFiles: 0,
    sourceWork: { appendedFiles: 0, replacedFiles: 0, parsedBytes: 0 } };
  const end = { event: "sync-end", instance: "executor", syncId: "sync-1", updatedFiles: 0, commits: 0 };
  const rows = [start, round, end];
  assert.equal(assertArchiveRequestStartup(rows).valid, true);
  for (const invalid of [[], [start, end], [start, round], [{ ...start, certifiedOnly: true }, round, end],
    [start, { ...round, sourceWork: { ...round.sourceWork, parsedBytes: 4653726517 } }, end],
    [start, round, { ...end, commits: 6, updatedFiles: 6 }],
    [start, { ...round, sourceWork: undefined }, end], [...rows, { event: "source-end", committed: true, parsedBytes: 0 }]]) {
    assert.throws(() => assertArchiveRequestStartup(invalid), error => error.code === "ARCHIVE_REQUEST_INVALID_START");
  }
});

test("bad metadata, missing packages and destinations outside this task fail before copying", async t => {
  const f = await fixture(t);
  await assert.rejects(archiveRequestPrepare({ mode: "unknown", root: f.root }), /mode/);
  await assert.rejects(archiveRequestPrepare({ label: "other", root: f.root }), /label/);
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", root: f.root, output: path.dirname(f.specs.year.seed) }), /task-local/);
  f.specs.current.mapping.packages[0].next.database_sha256 = "bad";
  await write(f.specs.current.mappingFile, f.specs.current.mapping);
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "current", root: f.root }));
  await rm(f.specs.year.mapping.packages[0].next.database_path);
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "year", root: f.root }));
  await assert.rejects(access(f.output), { code: "ENOENT" });
});

test("a failed product validation leaves a failed receipt and preserves the full seed", async t => {
  const f = await fixture(t), before = await digest(f.specs.current.seed);
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "current", root: f.root }));
  const receipt = await json(path.join(f.output, "receipt.json"));
  assert.equal(receipt.prepared, false); assert.match(receipt.failure, /database/);
  assert.equal(await digest(f.specs.current.seed), before);
  await assert.rejects(access(receipt.datasets[0].configFile), { code: "ENOENT" });
});

test("destination junctions cannot redirect a private copy into retained data", async t => {
  const f = await fixture(t), parent = path.dirname(f.output), alias = path.join(parent, "alias");
  await mkdir(parent, { recursive: true });
  await symlink(path.dirname(f.specs.current.seed), alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(archiveRequestPrepare({ mode: "prepare", label: "current", root: f.root, output: path.join(alias, "new") }), /aliases/);
});
