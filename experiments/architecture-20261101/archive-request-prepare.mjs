import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DAY, ROOT, datasetOptions } from "./c1-datasets.mjs";

const DAYS = { current: 49, year: 365, "two-years": 730 };
const PRIMARY = "usage-index.sqlite";
const SMALL_STATE_FILES = ["imports.json", "pricing.json", "pricing-auto.json"];
const RETAINED_TABLES = ["source_files", "history_replaced_facts", "rate_limit_observations", "quota_usage_sources"];
const RETAINED_META = ["history_archive_event_revisions", "official_quota_observations", "quota_source_log_evidence"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
const within = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function info(file) {
  try {
    const value = await lstat(file);
    assert.ok(value.isFile() && !value.isSymbolicLink(), `not a regular file: ${file}`);
    return { bytes: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function privateDestination(root, output) {
  assert.ok(within(path.join(root, "output/archive-request-lifetime-20261110"), output), "destination must be a new task-local directory");
  for (let cursor = output; cursor !== root; cursor = path.dirname(cursor)) {
    try {
      const value = await lstat(cursor);
      assert.ok(!value.isSymbolicLink(), `destination aliases another directory: ${cursor}`);
      assert.notEqual(cursor, output, "destination already exists; choose a new directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function planDataset(root, output, label, retained, metadata, runtime, views) {
  const datasetRoot = path.join(root, "output/c1-long-history-20261107/datasets", label);
  const proofFile = path.join(datasetRoot, "capacity-proof.json");
  const mappingFile = path.join(root, "output/archive-compaction-20261108/upgrades", label, "maintenance/compaction.json");
  const load = async file => {
    const bytes = await readFile(file);
    metadata.push({ file, sha256: sha256(bytes) });
    return JSON.parse(bytes);
  };
  // Capacity proofs contain the needed bounds/counts without reading the multi-MB raw-file inventories.
  const proof = await load(proofFile), mapping = await load(mappingFile);
  assert.equal(proof.label, label); assert.equal(proof.passed, true); assert.equal(proof.verification.passed, true);
  assert.equal(mapping.format, 1);
  assert.equal(mapping.packages.length, Math.ceil((DAYS[label] - 30) / 90));
  assert.equal(proof.packages.length, mapping.packages.length);
  const startMs = Math.floor(proof.verification.counts.minimum / DAY) * DAY;
  const endMs = (Math.floor(proof.verification.counts.maximum / DAY) + 1) * DAY;
  assert.equal(endMs - startMs, DAYS[label] * DAY);
  let cursor = startMs;
  const packages = [];
  for (const [index, { previous, next }] of mapping.packages.entries()) {
    assert.deepEqual({ startMs: next.start_ms, endMs: next.end_ms, eventCount: next.event_count }, proof.packages[index]);
    for (const key of ["start_ms", "end_ms", "event_count"]) assert.equal(next[key], previous[key]);
    assert.equal(next.start_ms, cursor); assert.equal(next.end_ms, Math.min(cursor + 90 * DAY, endMs - 30 * DAY));
    cursor = next.end_ms;
    const databaseFile = path.resolve(next.database_path);
    assert.ok(retained.has(databaseFile), `package absent from retained inventory: ${databaseFile}`);
    const manifestFile = databaseFile.replace(/\.sqlite$/, ".manifest.json");
    const manifest = await load(manifestFile), status = await info(databaseFile);
    assert.equal(manifest.formatVersion, 1); assert.match(next.segment_id, /^[a-f0-9]{64}$/);
    assert.equal(next.segment_id, next.database_sha256); assert.equal(manifest.database.sha256, next.database_sha256);
    assert.equal(manifest.database.filename, path.basename(databaseFile));
    assert.ok(status); assert.equal(status.bytes, manifest.database.bytes);
    assert.equal(manifest.tables.events.rows, next.event_count);
    packages.push({ databaseFile, manifestFile, sha256: next.database_sha256, bytes: status.bytes,
      startMs: next.start_ms, endMs: next.end_ms, eventCount: next.event_count });
  }
  assert.equal(cursor, endMs - 30 * DAY);
  const seedDirectory = path.join(datasetRoot, "seed-state"), source = path.join(seedDirectory, PRIMARY);
  assert.ok(retained.has(source), `full seed absent from retained inventory: ${source}`);
  const state = path.join(output, label, "state"), copies = [];
  for (const name of [PRIMARY, `${PRIMARY}-wal`, ...SMALL_STATE_FILES]) {
    const file = path.join(seedDirectory, name), status = await info(file);
    if (name === PRIMARY) assert.ok(status, `missing full seed: ${file}`);
    if (!status || (name.endsWith("-wal") && status.bytes === 0)) continue;
    if (SMALL_STATE_FILES.includes(name)) assert.ok(status.bytes <= 1024 * 1024, `unexpected large state metadata: ${file}`);
    copies.push({ source: file, target: path.join(state, name), ...status });
  }
  const wal = await info(`${source}-wal`);
  const config = { label, layout: "mixed", workspace: root, runtime,
    datasetFile: path.join(datasetRoot, "dataset.json"), seedDirectory, state,
    views: views ?? ["today", "week", "all"].map(preset => ({ preset, calendarZone: "utc" })).concat({
      preset: "custom", calendarZone: "utc", startDate: new Date(startMs).toISOString().slice(0, 10), endDate: new Date(endMs - 1).toISOString().slice(0, 10) }),
    startupAcceptance: { changedSources: 0, parsedBytes: 0, sourceCheckRequired: true },
    options: datasetOptions(path.join(datasetRoot, "home"), state) };
  return { label, config, copies, wal, packages, expectedEvents: proof.verification.counts.events,
    configFile: path.join(output, label, "config.json"), metaFile: path.join(output, label, "meta.json") };
}

function retainedFacts(database, factTables = RETAINED_TABLES) {
  const tables = Object.fromEntries(factTables.map(table => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().filter(row => row.pk).sort((a, b) => a.pk - b.pk);
    assert.ok(columns.length, `missing retained fact table: ${table}`);
    const order = columns.map(row => `"${row.name.replaceAll('"', '""')}"`).join(",");
    const hash = createHash("sha256"); let rows = 0;
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      hash.update(JSON.stringify(row) + "\n"); rows++;
    }
    return [table, { rows, sha256: hash.digest("hex") }];
  }));
  const meta = Object.fromEntries(RETAINED_META.map(key => [key,
    database.prepare("SELECT value FROM store_meta WHERE key=?").get(key)?.value ?? null]));
  return { tables, meta };
}

async function unchangedSeed(plan) {
  for (const copy of plan.copies) {
    const { source, target, ...status } = copy;
    assert.deepEqual(await info(source), status, `seed changed during preparation: ${source}`);
  }
  assert.deepEqual(await info(path.join(plan.config.seedDirectory, `${PRIMARY}-wal`)), plan.wal, "seed WAL changed during preparation");
}

function invalidStart(message) {
  return Object.assign(new Error(`Invalid startup fixture: ${message}; exclude this run from performance comparisons`), { code: "ARCHIVE_REQUEST_INVALID_START" });
}

function assertNoopRound(round) {
  if (round?.updatedFiles !== 0 || round?.sourceWork?.parsedBytes !== 0 ||
      round?.sourceWork?.appendedFiles !== 0 || round?.sourceWork?.replacedFiles !== 0 || round.error)
    throw invalidStart("source work is nonzero or its evidence is missing");
}

// Consume only the existing hook's bounded formal startup rows, before any intentional raw mutations.
export function assertArchiveRequestStartup(rows) {
  const starts = rows.filter(row => row.event === "sync-start"), ends = rows.filter(row => row.event === "sync-end");
  if (!starts.length || !starts.some(row => row.certifiedOnly === false)) throw invalidStart("no real source sync was observed");
  for (const start of starts) {
    const same = row => row.instance === start.instance && row.syncId === start.syncId;
    const matches = ends.filter(same), rounds = rows.filter(row => row.event === "round-end" && same(row));
    if (!start.instance || !start.syncId || matches.length !== 1 || matches[0].error || matches[0].commits !== 0)
      throw invalidStart("sync evidence is incomplete or sources committed");
    if (!start.certifiedOnly && (!rounds.length || matches[0].updatedFiles !== 0)) throw invalidStart("full source check is missing or changed sources");
    for (const round of rounds) assertNoopRound(round);
  }
  if (rows.some(row => row.event === "source-end" && (row.committed || Number(row.parsedBytes) > 0 || row.error)))
    throw invalidStart("startup processed a raw source");
  return { valid: true, syncs: starts.length, changedSources: 0, parsedBytes: 0 };
}

async function prepareDataset(plan) {
  const { UsageStore } = await import(pathToFileURL(path.join(plan.config.runtime, "src/usage-store.js")));
  const { prepareHistoryArchiveCommit } = await import(pathToFileURL(path.join(plan.config.runtime, "src/history-archive.js")));
  await mkdir(plan.config.state, { recursive: true });
  await unchangedSeed(plan);
  // Copy WAL, never SHM: SQLite recovers the frozen snapshot only in this independent private copy.
  for (const copy of plan.copies) await copyFile(copy.source, copy.target, constants.COPYFILE_EXCL);
  await unchangedSeed(plan);
  const file = plan.config.options.databaseFile, status = await lstat(file);
  assert.equal(status.nlink, 1); assert.equal(await realpath(file), file);
  const snapshot = new DatabaseSync(file);
  let before;
  try {
    assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM archive_segments").get().n, 0, "requires a full, unarchived seed");
    assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM events").get().n, plan.expectedEvents, "full seed/WAL differs from capacity proof");
    before = retainedFacts(snapshot);
  } finally { snapshot.close(); }
  const store = new UsageStore(plan.config.options), commits = [];
  try {
    await store.open();
    for (const entry of plan.packages) {
      const prepared = await prepareHistoryArchiveCommit(store.database, entry.databaseFile);
      assert.equal(prepared.candidate.databaseSha256, entry.sha256);
      assert.equal(prepared.candidate.startMs, entry.startMs); assert.equal(prepared.candidate.endMs, entry.endMs);
      assert.equal(prepared.deletion.ids.length, entry.eventCount);
      // The product transaction alone publishes event authority and deletes the verified event IDs.
      const committed = await store.commitHistoryArchiveEvents(prepared);
      assert.equal(committed.deletedEventCount, entry.eventCount); commits.push(committed);
    }
    assert.deepEqual(retainedFacts(store.database), before, "source identities or retained history changed");
    const hotEvents = store.database.prepare("SELECT COUNT(*) n FROM events").get().n;
    assert.equal(hotEvents + commits.reduce((sum, row) => sum + row.eventCount, 0), plan.expectedEvents);
    assert.equal(store.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.deepEqual((await readdir(plan.config.state)).filter(name => name.endsWith(".history-cache")), []);
    await unchangedSeed(plan);
    store.close();
    const normalization = { required: true, via: "original gateway before timing", formalStartupGuardRequired: true };
    await unchangedSeed(plan);
    const meta = { prepared: true, label: plan.label, expectedEvents: plan.expectedEvents, hotEvents, commits, normalization,
      retainedFacts: before, configFile: plan.configFile, packages: plan.packages, copies: plan.copies };
    await save(plan.configFile, plan.config); await save(plan.metaFile, meta);
    return meta;
  } finally { store.close(); }
}

export async function archiveRequestPrepare({ mode = "dry", label = "all", root = ROOT, output, runtime = ROOT, views } = {}) {
  assert.ok(["dry", "prepare"].includes(mode), "mode must be dry or prepare");
  assert.ok(label === "all" || Object.hasOwn(DAYS, label), "label must be current, year, two-years or all");
  root = await realpath(path.resolve(root));
  runtime = await realpath(path.resolve(runtime));
  for (const name of ["usage-store.js", "history-archive.js"]) assert.ok(await info(path.join(runtime, "src", name)), "runtime source is missing");
  output = path.resolve(output ?? path.join(root, "output/archive-request-lifetime-20261110/fixtures"));
  await privateDestination(root, output);
  const inventoryFile = path.join(root, "output/windows-parallel-20261109/cleanup/main-retained-sqlite.json");
  const inventoryBytes = await readFile(inventoryFile), inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.format, 1); assert.equal(inventory.complete, true);
  const retained = new Set(inventory.databases.map(row => path.resolve(row.path)));
  const metadata = [{ file: inventoryFile, sha256: sha256(inventoryBytes) }], datasets = [];
  for (const name of label === "all" ? Object.keys(DAYS) : [label]) datasets.push(await planDataset(root, output, name, retained, metadata, runtime, views));
  const receipt = { format: 1, mode, prepared: false, output, receiptFile: path.join(output, "receipt.json"), metadata, datasets,
    copyBytes: datasets.reduce((sum, row) => sum + row.copies.reduce((n, copy) => n + copy.bytes, 0), 0),
    rawCopyBytes: 0, packageCopyBytes: 0 };
  if (mode === "dry") return receipt;
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  try {
    for (const plan of datasets) plan.result = await prepareDataset(plan);
    receipt.prepared = true;
    return receipt;
  } catch (error) {
    receipt.failure = String(error.stack ?? error);
    throw error;
  } finally { await save(receipt.receiptFile, receipt); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length >= 3 && process.argv.length <= 6, "dry|prepare [current|year|two-years|all] [newTaskDirectory] [runtimeDirectory]");
  console.log(JSON.stringify(await archiveRequestPrepare({ mode: process.argv[2], label: process.argv[3] ?? "all", output: process.argv[4], runtime: process.argv[5] }), null, 2));
}
