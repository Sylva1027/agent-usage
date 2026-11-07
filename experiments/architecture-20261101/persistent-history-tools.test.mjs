import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { ROOT, BASE, KINDS } from "./c1-datasets.mjs";
import { GROUPS, filesUnder, hashEntries, verifyEntries, verifyFrozenRuntime, scenePaths, fingerprint, assertMatrix, REPLAY_PHASES, buildClockReplay, replayMutationTimes, writeReplayClock } from "./persistent-history-prepare.mjs";
import { exactParity, executorReuseParity, regressionPassed, memoryGate, workGate, archiveProofSummary, spoolSummary, clockReplayGate, storageCoverage, assertSameMeasurementTools, assertUnchangedCurrentReplayHook, VALIDATION_CHECKS } from "./persistent-history-analyze.mjs";
import { projectionStorage } from "./c1-telemetry.mjs";
import { appendC1Mutation } from "./c1-source-mutations.mjs";

async function temporary(action, root = os.tmpdir()) {
  const directory = await mkdtemp(path.join(root, ".persistent-history-tools-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("fixed six groups keep original inputs and isolate scene/state outputs", () => {
  assert.equal(GROUPS.length, 6); assert.equal(GROUPS.filter(row => row.label === "current").length, 4);
  assert.equal(GROUPS.filter(row => row.label === "year").length, 2); assert.ok(GROUPS.every(row => row.label !== "two-years"));
  assertMatrix(GROUPS); assert.throws(() => assertMatrix([...GROUPS, GROUPS[0]]));
  assert.throws(() => assertMatrix([...GROUPS, GROUPS[0], GROUPS[1]]));
  const dataset = { label: "current", root: path.join(BASE, "datasets/current") }, resultRoot = path.join(BASE, "../persistent-test-output");
  const paths = scenePaths(dataset, "mixed", "mixed-candidate", resultRoot);
  assert.equal(paths.seed, path.join(dataset.root, "seed-mixed"));
  assert.equal(paths.directory, path.join(resultRoot, "datasets/current/scene-mixed-candidate"));
  assert.equal(paths.state, path.join(resultRoot, "datasets/current/state-scene-mixed-candidate"));
  assert.throws(() => scenePaths(dataset, "hot", "../escape", resultRoot));
  assert.equal(VALIDATION_CHECKS.filter(name => name.startsWith("recovery-")).length, 4);
});

test("runtime inventory includes new dynamic modules; hashes reject drift and extra files", () => temporary(async directory => {
  await mkdir(path.join(directory, "src/nested"), { recursive: true });
  const file = path.join(directory, "src/nested/new-projection.js"); await writeFile(file, "export const revision=1;\n");
  assert.deepEqual(await filesUnder(directory), [path.join("src/nested/new-projection.js")]);
  const entries = await hashEntries([file]); await verifyEntries(entries);
  const spec = { directory, hashes: { [path.relative(directory, file)]: entries[0].sha256 } };
  await verifyFrozenRuntime(spec);
  await writeFile(path.join(directory, "unrecorded.js"), "extra");
  await assert.rejects(verifyFrozenRuntime(spec), /unrecorded runtime/);
  await writeFile(file, "export const revision=2;\n");
  await assert.rejects(verifyEntries(entries), /drift/);
}));

test("current regression requires both thresholds, with no rounding", () => {
  assert.equal(regressionPassed(100, 201), false);
  assert.equal(regressionPassed(1000, 1100), true);
  assert.equal(regressionPassed(1000, 1100.00001), false);
  assert.equal(regressionPassed(10, 100), true);
  assert.throws(() => regressionPassed(undefined, 5));
});

test("storage inventory and allocation coverage remain separate when a changing WAL cannot be measured", () => {
  const full = { complete: true, allocatedBytes: 10, observedBytes: 10, files: [{ relativePath: "cache.sqlite", bytes: 10 }], warnings: [] };
  const partial = { ...full, complete: false, allocatedBytes: null, warnings: ["allocation: cache.sqlite-wal: unavailable"] };
  assert.deepEqual(storageCoverage([{ state: partial, temp: full }]), {
    inventoryComplete: true, allocationComplete: false, allocationUnavailableScopes: 1,
  });
  assert.equal(storageCoverage([{ state: { ...partial, warnings: ["enumeration failed"] }, temp: full }]).inventoryComplete, false);
  assert.equal(storageCoverage([{ state: { ...partial, observedBytes: 11 }, temp: full }]).inventoryComplete, false);
  assert.equal(storageCoverage([]).inventoryComplete, false);
});

test("analysis-only corrections can retain measurements but changed runners and samplers cannot", () => {
  const tools = ["c1-run.mjs", "c1-telemetry.mjs", "b2-attribution-resource.ps1", "persistent-history-prepare.mjs", "persistent-history-analyze.mjs"].map(file => ({ file, sha256: "old" }));
  assertSameMeasurementTools(tools, tools.map(row => row.file === "persistent-history-analyze.mjs" ? { ...row, sha256: "new" } : row));
  for (const file of tools.slice(0, 4).map(row => row.file)) assert.throws(() => assertSameMeasurementTools(tools,
    tools.map(row => row.file === file ? { ...row, sha256: "new" } : row)));
});

async function replayFixture(directory) {
  const seedFile = path.join(directory, "seed.sqlite"), finalStateFile = path.join(directory, "final.sqlite");
  const seed = new DatabaseSync(seedFile), final = new DatabaseSync(finalStateFile), plans = [], changes = [];
  const oldTime = Date.parse("2026-11-03T00:00:00.000Z"), appendTime = Date.parse("2026-11-06T20:00:00.000Z");
  const schema = "CREATE TABLE events(id INTEGER PRIMARY KEY,source_path TEXT,timestamp_ms INTEGER,session_id TEXT,total INTEGER,input INTEGER,cached INTEGER,output INTEGER,reasoning INTEGER)";
  try {
    seed.exec(schema); final.exec(schema);
    for (const [index, kind] of KINDS.entries()) {
      const source = path.join(directory, `${kind}.jsonl`), reasoning = ["codex", "zcode", "opencode", "workbuddy"].includes(kind) ? 5 : 0;
      const original = [index + 1, source, oldTime, kind, 141, 140, 30, 1, reasoning];
      seed.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(...original);
      final.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(index + 101, ...original.slice(1));
      const timestampMs = appendTime + index * 1000;
      final.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(index + 201, source, timestampMs, kind, 160, 140, 30, 20, reasoning);
      plans.push({ kind, filePath: source, ...(index >= 2 ? { deliveryPlan: { appendTimeMs: timestampMs - 1000, original: { timestampMs: oldTime } } } : {}) });
      changes.push({ name: `append-${kind}`, startedAtMs: timestampMs + (kind === "dsh" ? 23 : 0), landedAtMs: timestampMs + 24 });
    }
    final.exec("UPDATE events SET total=160,output=20 WHERE session_id='zcode' AND id<200");
    // Unchanged 160 rows with different physical ids are not additions.
    for (const database of [seed, final]) database.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(database === seed ? 9 : 109, plans[1].filePath, oldTime - 1000, "existing", 160, 140, 30, 20, 0);
  } finally { seed.close(); final.close(); }
  const reference = { directory: path.join(directory, "scene"), queryDirectory: path.join(directory, "ranges"), finalStateFile };
  await mkdir(reference.directory); await mkdir(reference.queryDirectory);
  for (const [index, phase] of REPLAY_PHASES.entries()) {
    const query = ["today", "week", "custom", "back-all"].includes(phase);
    await writeFile(path.join(query ? reference.queryDirectory : reference.directory, `${phase}.json`), JSON.stringify({
      metadata: { modelUsageAsOf: new Date(appendTime + index * 60000).toISOString() }, summary: { range: { calendarZone: "utc" } } }));
  }
  await writeFile(path.join(reference.directory, "mutation-plans.json"), JSON.stringify(plans));
  await writeFile(path.join(reference.directory, "result.json"), JSON.stringify({ passed: true, changes }));
  return { reference, seedFile, plans, changes, appendTime };
}

test("year replay binds phase response hashes and exact six row deltas, without id or ZCode revision confusion", () => temporary(async directory => {
  const { reference, seedFile, plans, changes, appendTime } = await replayFixture(directory);
  const replay = await buildClockReplay(reference, seedFile);
  assert.equal(replay.phases.length, 14); assert.equal(replay.mutations.length, 6);
  assert.equal(replay.mutations[1].timestampMs, appendTime + 1000);
  assert.notEqual(replay.mutations[1].timestampMs, changes[1].startedAtMs, "DSH must use the actual new row, not guess receipt milliseconds");
  assert.equal(replay.mutations[4].timestampMs, plans[4].deliveryPlan.appendTimeMs + 1000);
  assert.equal(replay.phases.find(row => row.phase === "today").file, path.join(reference.queryDirectory, "today.json"));
  await verifyEntries(replay.phases.map(row => ({ file: row.file, sha256: row.sha256 })));
  const final = new DatabaseSync(reference.finalStateFile);
  try { final.exec("INSERT INTO events SELECT 999,source_path,timestamp_ms,session_id,total,input,cached,output,reasoning FROM events WHERE id=202"); } finally { final.close(); }
  assert.throws(() => replayMutationTimes(reference.finalStateFile, seedFile, plans, changes), /multiplicity/);
}));

test("year phase driver atomically publishes all stages and gate rejects missing or altered clocks", () => temporary(async directory => {
  const { reference, seedFile } = await replayFixture(directory), replay = await buildClockReplay(reference, seedFile), file = path.join(directory, "clock.json");
  const phaseWrites = [], businessClocks = [];
  for (const phase of [...REPLAY_PHASES.slice(0, 6), "repeat-all", "after-executor-exit-all", ...REPLAY_PHASES.slice(6)]) {
    const write = await writeReplayClock(file, replay, phase); phaseWrites.push(write);
    const current = JSON.parse(await readFile(file, "utf8")); businessClocks.push({ ...current, readAtMs: Date.now() });
    assert.equal(current.asOf, write.asOf); await assert.rejects(stat(`${file}.next`), { code: "ENOENT" });
  }
  assert.equal(phaseWrites[6].asOf, replay.phases.find(row => row.phase === "initial-all").asOf);
  await assert.rejects(writeReplayClock(file, replay, "unknown"), /missing replay phase/);
  const clockReplayFingerprint = fingerprint(replay), scene = { evidence: { clockReplayFingerprint }, clockReplay: { fingerprint: clockReplayFingerprint, phaseWrites } };
  const planned = replay.mutations.map(row => ({ kind: row.kind, filePath: row.filePath, replayTimestampMs: row.timestampMs,
    ...(["codex", "dsh"].includes(row.kind) ? {} : { deliveryPlan: { appendTimeMs: row.timestampMs - 1000 } }) }));
  clockReplayGate(scene, { clockReplay: replay, clockReplayFingerprint }, businessClocks, planned);
  businessClocks[0].asOf = "2001-01-01T00:00:00.000Z";
  assert.throws(() => clockReplayGate(scene, { clockReplay: replay, clockReplayFingerprint }, businessClocks, planned));
}, ROOT));

test("Codex and DSH replay only payload timestamps while receipts and mtime stay real", () => temporary(async directory => {
  const home = path.join(directory, "home"), originals = path.join(directory, "originals"); await mkdir(home); await mkdir(originals);
  const replayTimestampMs = Date.parse("2026-11-06T20:01:02.003Z");
  for (const kind of ["codex", "dsh"]) {
    const filePath = path.join(home, `${kind}.jsonl`); await writeFile(filePath, "");
    const before = Date.now(), receipt = await appendC1Mutation({ kind, datasetHome: home, originalsDirectory: originals,
      filePath, backupFile: path.join(originals, kind), replayTimestampMs, dshHeader: {} });
    assert.ok(receipt.startedAtMs >= before && receipt.landedAtMs <= Date.now());
    assert.ok((await stat(filePath)).mtimeMs >= before - 10);
    const bytes = await readFile(filePath), text = kind === "dsh" ? zstdDecompressSync(bytes).toString() : bytes.toString();
    const rows = text.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(kind === "dsh" ? rows[1].time : Date.parse(rows[1].timestamp), replayTimestampMs);
  }
}));

function body(asOf = "2026-11-07T12:00:00.000Z") {
  return { metadata: { modelUsageAsOf: asOf, eventCount: 1, sessionCount: 1, homeCount: 1 }, pricingCatalog: { models: {} },
    summary: { range: { start: "2026-11-07T00:00:00.000Z", end: "2026-11-07T23:59:59.999Z" }, totals: { total: 20 },
      comparison: { previousRange: { start: "2026-11-06T00:00:00.000Z", end: "2026-11-06T23:59:59.999Z" }, previousTotals: { total: 100 },
        averageBaselineTotal: 50, averageDelta: -30, averagePercentChange: -60 },
      costEstimate: { total: 0.1 }, channels: [], models: [], timeline: [], records: { first: "😀", second: "\uE000" },
      eventCount: 1, sessionCount: 1, homeCount: 1, quota: { asOf, limitId: "codex", ignoredBucketCount: 0, windows: { live: asOf } } }, periodComparison: { totals: { all: { total: 20 } }, asOf } };
}
test("exact same-layout amounts and order; observation-time fields are verified before alignment", () => {
  const old = body(), now = body("2026-11-07T18:00:00.000Z");
  Object.assign(now.summary.comparison, { averageBaselineTotal: 75, averageDelta: -55, averagePercentChange: -73.33 });
  exactParity(now, old);
  now.summary.costEstimate.total += 1e-12; assert.throws(() => exactParity(now, old));
  now.summary.costEstimate.total = 0.1; now.summary.records.first = "\uE000"; assert.throws(() => exactParity(now, old));
  const invalid = body(); invalid.summary.comparison.averageDelta++; assert.throws(() => exactParity(invalid, old), /observation-time/);
  const period = body(); period.periodComparison.totals.all.total++; assert.throws(() => exactParity(period, old));
  const quota = body(); quota.summary.quota.ignoredBucketCount++; assert.throws(() => exactParity(quota, old));
  exactParity(old, structuredClone(old), false, true);
  assert.throws(() => exactParity(body("2026-11-07T12:00:01.000Z"), old, false, true), /business asOf/);
});

test("executor reuse changes only HTTP shape, keeping the exact all/day business context", () => {
  const original = { preset: "all", bucket: "day", recentValue: "" }, bypass = { ...original, recentValue: "今年" };
  assert.notDeepEqual(bypass, original);
  const businessKey = ({ preset, bucket }) => ({ preset, bucket }); assert.deepEqual(businessKey(bypass), businessKey(original));
  const old = body(), probe = body(); Object.assign(old.summary.range, { preset: "all", bucket: "day" });
  Object.assign(probe.summary.range, { preset: "all", bucket: "day" }); executorReuseParity(probe, old);
  old.summary.range.bucket = probe.summary.range.bucket = "week"; executorReuseParity(probe, old);
  probe.summary.costEstimate.total += 1e-12; assert.throws(() => executorReuseParity(probe, old));
  probe.summary.costEstimate.total = 0.1; probe.summary.range.bucket = "month"; assert.throws(() => executorReuseParity(probe, old));
});

const node = (role, rssMiB, start, end) => ({ role, code: 0, startedAtMs: start, endedAtMs: end, usage: { maxRSS: rssMiB * 1024 },
  execArgv: role === "executor" ? ["--max-old-space-size=224", "--max-semi-space-size=4"] : ["--max-old-space-size=512"] });
const sample = () => ({ service: { processCount: 2, memoryAvailableProcessCount: 2, workingSetBytes: 400 * 1048576, reportedPeakWorkingSetBytes: 410 * 1048576 }, processes: [] });
test("memory checks complete lifecycle overlap and exact 512 MiB, with browser separate", () => {
  const samples = [sample()], nodes = [node("gateway", 150, 0, 100), node("executor", 362, 10, 90)];
  assert.equal(memoryGate(samples, nodes, 1).passed, true);
  nodes[1].usage.maxRSS++; assert.equal(memoryGate(samples, nodes, 1).passed, false);
  nodes[1].endedAtMs = -1; assert.equal(memoryGate(samples, nodes, 1).complete, false);
  assert.equal(memoryGate(samples, [node("gateway", 150, 0, 100)], 1).passed, false);
  samples[0].service.memoryAvailableProcessCount = 1; assert.equal(memoryGate(samples, nodes, 1).passed, false);
});

function workFixture() {
  const version = { facts: 7 }, storage = phase => ({ phase, databaseCount: 1, orphanDatabases: [], candidate: null, walBytes: 0, present: true });
  const scene = { label: "year", layout: "mixed", initialAll: { startedAtMs: 1, endedAtMs: 10 },
    changes: [{ name: "append-codex", landedAtMs: 20, endedAtMs: 30 }], scopes: [],
    reopen: { serviceStartedAtMs: 40, endedAtMs: 50 }, reuseChecks: { executorExit: { code: 0, pid: 41, endedAtMs: 12 }, repeat: { startedAtMs: 11, endedAtMs: 12 }, afterExit: {
      cache: "miss", bucket: "day", recentValue: "今年", cacheBypass: "unused recentValue only; same all/day business context", startedAtMs: 13, endedAtMs: 15 } },
    storage: [...Array.from({ length: 8 }, () => storage("append")), storage("closed"), storage("reopen-closed")] };
  const row = start => ({ pid: 42, startedAtMs: start, endedAtMs: start + 1, inputVersion: version,
    publishedVersion: { status: "ready", inputs_json: JSON.stringify(version) }, work: { rows: 0, views: { all: { readEvents: 0 } }, projection: { rebuilt: false, coldCopied: 0, hotCopied: 0 } } });
  return { scene, measured: { archiveProofs: [], archiveProof: { successfulCalls: 2, failedCalls: 0 }, nodes: [{ role: "executor", pid: 42, startedAtMs: 13, endedAtMs: 16 }], history: [row(13), row(22), row(41)], sync: [], publications: [], storageEvidenceComplete: true, projectionDatabasePeakCount: 1 } };
}
test("projection gates reject cold copies, reopen rebuilds, half versions, candidates, WAL and missing evidence", () => {
  let { scene, measured } = workFixture(); assert.equal(workGate(scene, measured).passed, true);
  measured.history[0].work.projection.coldCopied = 1; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); measured.history[1].work.projection.rebuilt = true; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); measured.history[0].publishedVersion.inputs_json = "{}"; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); scene.storage.at(-1).walBytes = 1; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); scene.storage.at(-1).candidate = { file: "pending.sqlite" }; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); measured.history = []; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); measured.history[0].work.views.all.readEvents = 1; assert.equal(workGate(scene, measured).passed, false);
  ({ scene, measured } = workFixture()); measured.archiveProof.failedCalls = 1; assert.equal(workGate(scene, measured).passed, false);
  assert.equal(fingerprint({ revision: 1 }), fingerprint({ revision: 1 }));
});

test("cold single-archive success proves reuse only for this all/day operation and new executor", () => {
  const { scene, measured } = workFixture();
  measured.history[0].work.views = {};
  assert.equal(workGate(scene, measured).passed, false);
  const receipt = { pid: 42, startedAtMs: 13, endedAtMs: 14, path: "single-archive-all", success: true,
    requestedPreset: "all", preset: "all", bucket: "day", resolvedBucket: "week", segmentId: "tiny-segment", summaryProjectionCacheReused: false };
  measured.fastHistory = [receipt];
  assert.equal(workGate(scene, measured).passed, true, "cold cache identity need not be reused");
  measured.history.shift();
  assert.equal(workGate(scene, measured).diskReuse, true, "fast path need not open a generic history reader");
  assert.equal(workGate(scene, measured).passed, true);
  for (const invalid of [{ success: false }, { error: "verification failed" }, { pid: 41 }, { pid: 43 },
    { startedAtMs: 12 }, { endedAtMs: 16 }, { endedAtMs: 12 }, { requestedPreset: "today" }, { preset: "today" },
    { bucket: "week" }, { segmentId: null }, { summaryProjectionCacheReused: undefined }]) {
    measured.fastHistory = [{ ...receipt, ...invalid }];
    assert.equal(workGate(scene, measured).passed, false, JSON.stringify(invalid));
  }
  measured.fastHistory = [receipt];
  scene.reuseChecks.afterExit.bucket = "week"; assert.equal(workGate(scene, measured).passed, false);
  scene.reuseChecks.afterExit.bucket = "day";
  measured.archiveProof.failedCalls = 1; assert.equal(workGate(scene, measured).passed, false);
  measured.archiveProof.failedCalls = 0;
  measured.history[0].publishedVersion.inputs_json = "{}"; assert.equal(workGate(scene, measured).passed, false);
});

test("storage snapshots distinguish published/candidate/WAL and abandoned files", () => temporary(async directory => {
  assert.equal(projectionStorage(directory).present, false);
  const cache = path.join(directory, "usage-index.sqlite.history-cache"); await mkdir(cache);
  for (const [name, size] of [["published.sqlite", 16], ["candidate.sqlite", 8], ["published.sqlite-wal", 4], ["abandoned.sqlite", 2], ["maintenance.lock", 32]]) await writeFile(path.join(cache, name), Buffer.alloc(size));
  await writeFile(path.join(cache, "current.json"), JSON.stringify({ file: "published.sqlite" }));
  await writeFile(path.join(cache, "candidate.json"), JSON.stringify({ file: "candidate.sqlite" }));
  const snapshot = projectionStorage(directory);
  assert.equal(snapshot.publishedBytes, 16); assert.equal(snapshot.candidateBytes, 8); assert.equal(snapshot.walBytes, 4);
  assert.equal(snapshot.databaseCount, 3); assert.deepEqual(snapshot.orphanDatabases, ["abandoned.sqlite"]);
  assert.equal(snapshot.maintenanceLockBytes, 32); assert.ok(snapshot.totalBytes >= 62);
}));

test("actual telemetry hooks accept only nonnull fast results and keep diagnostics opt-in and both hashes", () => temporary(async directory => {
  const source = path.join(directory, "src"); await mkdir(source);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(source, "usage-store.js"), `export class UsageStore {
    constructor(){this.databaseFile=${JSON.stringify(path.join(directory, "usage-index.sqlite"))};this.database={prepare(){return {get(){return {page_count:0}}}}};}
    async withSqlHistoryReader(){this.lastHistoryQueryWork={projection:{rebuilt:false,coldCopied:0}};return 7;}
    async trySingleSqlHistoryDashboard(filters){
      if(filters.result==='null')return null;if(filters.result==='error')throw Error('tiny fast failure');
      this.historySqlDashboardCache??={key:JSON.stringify([null,0,{segment_id:'tiny-segment'}]),store:new UsageStore()};
      const reader=this.historySqlDashboardCache.store;reader.verifiedHistorySqlRead=true;
      return {summary:reader.summarizeInReadTransaction(),metadata:reader.metadata(),periodComparison:reader.periodComparison()};
    }
    summarizeInReadTransaction(){this.summaryProjectionCache??={};return {range:{preset:'all',bucket:'week'}};}
    async checkSources(fail){if(fail)throw Error('tiny source failure');return 1;}
    metadata(){return 2;}
    periodComparison(fail){if(fail)throw Error('tiny period failure');return 3;}
  }`);
  await writeFile(path.join(source, "usage-summary-cache.js"), `export class UsageSummaryCache {async readSourceState(){return 4;}}`);
  await writeFile(path.join(source, "history-backup.js"), `let calls=0;
    async function hashFile(file){calls++;if(file==='bad')throw Error('tiny hash failure');return {bytes:7,sha256:'tiny-digest'};}
    export async function verify(file){const first=await hashFile(file),second=await hashFile(file);return {first,second,calls};}`);
  const entry = path.join(directory, "run.mjs");
  await writeFile(entry, `import assert from 'node:assert/strict';import {UsageStore} from './src/usage-store.js';import {verify} from './src/history-backup.js';
    import {UsageSummaryCache} from './src/usage-summary-cache.js';
    const store=new UsageStore();assert.equal(await store.withSqlHistoryReader(),7);
    for(let i=0;i<2;i++)assert.equal((await store.trySingleSqlHistoryDashboard({preset:'all',bucket:'day'})).summary.range.bucket,'week');
    assert.equal(await store.trySingleSqlHistoryDashboard({preset:'all',result:'null'}),null);
    await assert.rejects(store.trySingleSqlHistoryDashboard({preset:'all',result:'error'}),/tiny fast failure/);
    assert.equal(await store.checkSources(),1);await assert.rejects(store.checkSources(true),/tiny source failure/);
    assert.throws(()=>store.periodComparison(true),/tiny period failure/);
    assert.equal(await new UsageSummaryCache().readSourceState(),4);
    assert.deepEqual(await verify('tiny'),{first:{bytes:7,sha256:'tiny-digest'},second:{bytes:7,sha256:'tiny-digest'},calls:2});
    await assert.rejects(verify('bad'),/tiny hash failure/);`);
  const telemetry = new URL("./c1-telemetry.mjs", import.meta.url).href;
  const env = { ...process.env, REMAINING_DELIVERY_TRACE: directory }; delete env.NODE_OPTIONS; delete env.C1_METHOD_DIAGNOSTIC;
  let run = spawnSync(process.execPath, ["--import", telemetry, entry], { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await filesUnder(directory)).some(file => /^method-.*\.ndjson$/.test(file)), false);
  const historyFile = (await filesUnder(directory)).find(file => /^history-.*\.ndjson$/.test(file)); assert.ok(historyFile);
  const rows = (await readFile(path.join(directory, historyFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows[0].work.projection.rebuilt, false); assert.equal(rows[0].projectionStorage.present, false);
  const proofFile = (await filesUnder(directory)).find(file => /^archive-proof-.*\.ndjson$/.test(file)); assert.ok(proofFile);
  const proofs = (await readFile(path.join(directory, proofFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(proofs.length, 3); assert.equal(proofs[2].bytes, null); assert.match(proofs[2].error, /tiny hash failure/);
  const summary = archiveProofSummary(proofs);
  assert.equal(summary.hashBytes, 14); assert.equal(summary.successfulCalls, 2); assert.equal(summary.failedCalls, 1);
  assert.ok(summary.hashMs >= 0); assert.equal(summary.files.find(row => row.file === "tiny").calls, 2);
  const fastFile = (await filesUnder(directory)).find(file => /^fast-history-.*\.ndjson$/.test(file)); assert.ok(fastFile);
  const receipts = (await readFile(path.join(directory, fastFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(receipts.length, 2, "null and thrown calls must not emit receipts");
  assert.deepEqual(receipts.map(row => row.summaryProjectionCacheReused), [false, true]);
  for (const row of receipts) {
    assert.ok(row.pid > 0 && row.startedAtMs <= row.endedAtMs && row.durationMs >= 0);
    assert.equal(row.success, true); assert.equal(row.requestedPreset, "all"); assert.equal(row.bucket, "day");
    assert.equal(row.resolvedBucket, "week"); assert.equal(row.segmentId, "tiny-segment");
  }
  env.C1_METHOD_DIAGNOSTIC = "1";
  run = spawnSync(process.execPath, ["--import", telemetry, entry], { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const methodFile = (await filesUnder(directory)).find(file => /^method-.*\.ndjson$/.test(file)); assert.ok(methodFile);
  const spans = (await readFile(path.join(directory, methodFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(new Set(spans.map(row => row.method)).size, 5);
  assert.ok(spans.every(row => row.startedAtMs <= row.endedAtMs && row.durationMs >= 0));
  assert.deepEqual(spans.filter(row => row.method === "UsageStore.summarizeInReadTransaction").map(row =>
    [row.verifiedHistorySqlRead, row.summaryProjectionCacheReused]), [[true, false], [true, true]]);
  assert.match(spans.find(row => row.method === "UsageStore.checkSources" && row.error).error, /tiny source failure/);
  assert.match(spans.find(row => row.method === "UsageStore.periodComparison" && row.error).error, /tiny period failure/);
}));

test("a historical calendar correction cannot silently change current measurement code", () => {
  const start = '    if (url.endsWith("/src/server.js") && process.env.C1_BUSINESS_CLOCK_FILE) {';
  const end = '    if (url.endsWith("/src/history-backup.js")) {';
  const before = `prefix\n${start}\nold calendar hook\n}\n${end}\nsuffix`;
  const after = before.replace("old calendar hook", "aligned calendar hook");
  assertUnchangedCurrentReplayHook(before, after);
  assert.throws(() => assertUnchangedCurrentReplayHook(before, after.replace("prefix", "changed")));
  assert.throws(() => assertUnchangedCurrentReplayHook(before, after.replace("suffix", "changed")));
  assert.throws(() => assertUnchangedCurrentReplayHook(before, after.replace(start, "")));
});

test("targeted fake server clock hook replays atomic phases and leaves current, frozen and wall clocks intact", () => temporary(async directory => {
  const source = path.join(directory, "src"); await mkdir(source);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(source, "server.js"), `export function createUsageServer(options = {}) {
    const frozen=options.frozen;const asOf = frozen?.asOf || new Date();return {asOf,wall:Date.now(),other:new Date()};
  }export function unrelatedDate(){return new Date();}
  function localPricingCatalog(){return {};}
  const status={fingerprint:'F0'},publishedSource={};
  function usageVersion(fingerprint,source,catalog,asOf=new Date()){return asOf;}
  export function statusDate(){const catalog = localPricingCatalog();
        const asOf = new Date();return asOf;}
  export function noticeDate(){const catalog=localPricingCatalog();return usageVersion(status?.fingerprint, publishedSource, catalog);}`);
  const file = path.join(directory, "clock.json"), replay = { phases: ["default", "initial-all"].map((phase, index) => ({
    phase, asOf: new Date(Date.parse("2026-11-06T20:00:00.000Z") + index * 1000).toISOString(), file: phase, sha256: phase })) };
  await writeReplayClock(file, replay, "default");
  const entry = path.join(directory, "run.mjs"), support = new URL("./persistent-history-prepare.mjs", import.meta.url).href;
  await writeFile(entry, `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
    import {createUsageServer,unrelatedDate,statusDate,noticeDate} from './src/server.js';import {writeReplayClock} from ${JSON.stringify(support)};
    const originalNow=Date.now,before=Date.now(),file=${JSON.stringify(file)},replay=${JSON.stringify(replay)};
    const first=createUsageServer();assert.ok(first.wall>=before);assert.ok(first.other.getTime()>=before);assert.ok(unrelatedDate().getTime()>=before);
    if(process.env.C1_BUSINESS_CLOCK_FILE){
      assert.equal(first.asOf.toISOString(),replay.phases[0].asOf);
      assert.equal(statusDate().toISOString(),first.asOf.toISOString());
      assert.equal(noticeDate().toISOString(),first.asOf.toISOString());
      const errors=[];const timer=setInterval(()=>{try{JSON.parse(readFileSync(file,'utf8'));}catch(error){errors.push(error.message);}},1);
      try{for(let i=0;i<32;i++){
        const phase=i%2?'default':'initial-all';await writeReplayClock(file,replay,phase);
        assert.equal(createUsageServer().asOf.toISOString(),replay.phases.find(row=>row.phase===phase).asOf);
        assert.equal(statusDate().toISOString(),replay.phases.find(row=>row.phase===phase).asOf);
        assert.equal(noticeDate().toISOString(),replay.phases.find(row=>row.phase===phase).asOf);
      }}finally{clearInterval(timer);}assert.deepEqual(errors,[]);
      const frozen=new Date('2000-01-01T00:00:00.000Z');assert.equal(createUsageServer({frozen:{asOf:frozen}}).asOf,frozen);
    }else{assert.ok(first.asOf.getTime()>=before);assert.ok(statusDate().getTime()>=before);assert.ok(noticeDate().getTime()>=before);}
    assert.equal(Date.now,originalNow);assert.ok(Date.now()>=before);`);
  for (const historical of [false, true]) {
    const env = { ...process.env, REMAINING_DELIVERY_TRACE: directory }; delete env.NODE_OPTIONS; delete env.C1_BUSINESS_CLOCK_FILE;
    if (historical) env.C1_BUSINESS_CLOCK_FILE = file;
    const run = spawnSync(process.execPath, ["--import", new URL("./c1-telemetry.mjs", import.meta.url).href, entry], { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
  }
}, ROOT));

test("spool telemetry observes real spilled lifetimes without retaining containers or treating logical pages as physical bytes", () => temporary(async directory => {
  const entry = path.join(directory, "rows.mjs"), rowsModule = new URL("../../src/usage-source-rows.js", import.meta.url).href;
  await writeFile(entry, `import {UsageSourceRows} from ${JSON.stringify(rowsModule)};
    const memory=new UsageSourceRows();memory.set('a',{value:1});memory.close();
    const disk=new UsageSourceRows(0);for(let i=0;i<8;i++)disk.set(String(i),{value:i});disk.close();disk.close();`);
  const env={...process.env,REMAINING_DELIVERY_TRACE:directory};delete env.NODE_OPTIONS;
  const run=spawnSync(process.execPath,["--import",new URL("./c1-telemetry.mjs",import.meta.url).href,entry],{env,encoding:"utf8",windowsHide:true,timeout:10000});
  assert.equal(run.status,0,run.stderr);
  const file=(await filesUnder(directory)).find(file=>/^spool-.*\.ndjson$/.test(file));assert.ok(file);
  const rows=(await readFile(path.join(directory,file),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(rows.length,1);assert.ok(rows[0].stats.peakScratchBytes>0);
  const summary=spoolSummary(rows);assert.equal(summary.failedCloses,0);assert.equal(summary.containers,1);
  assert.equal(summary.overlapPeakScratchUpperBoundBytes,rows[0].stats.peakScratchBytes);assert.equal(summary.anonymousPhysicalBytes,null);
  const overlap=spoolSummary([{start:0,end:10,stats:{spilled:true,peakScratchBytes:5,peakMemoryBytes:2}},
    {start:5,end:20,stats:{spilled:true,peakScratchBytes:7,peakMemoryBytes:3}}]);
  assert.equal(overlap.overlapPeakScratchUpperBoundBytes,12);
}));
