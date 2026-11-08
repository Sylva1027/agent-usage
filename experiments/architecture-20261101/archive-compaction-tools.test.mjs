import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { compareHistoryDatabases } from "../../src/history-compact.js";
import { ensureHistoryProjectionTracking } from "../../src/usage-history-projection-store.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-compaction-tools-"));
after(async () => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
});
// Relocate the experiment to tiny inputs; retain real hashing, SQLite, admission and replay code.
const hooks = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url === new URL("./c1-datasets.mjs", import.meta.url).href) {
    const source = String(loaded.source), expression = 'fileURLToPath(new URL("../../",import.meta.url))';
    assert.ok(source.includes(expression)); return { ...loaded, source: source.replace(expression, JSON.stringify(root)) };
  }
  if (url === new URL("./persistent-history-prepare.mjs", import.meta.url).href) {
    let source = String(loaded.source);
    for (const [start, end, replacement] of [
      ["export async function toolReceipt()", "export async function filesUnder", `export async function toolReceipt() {
        const entries = await hashEntries([path.join(ROOT,"tool-anchor.mjs")]); return {entries,sha256:fingerprint(entries)};
      }\n\n`],
      ["export async function environment()", "export function replayMutationTimes", "export async function environment() { return {fixture:true}; }\n\n"],
    ]) {
      const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from);
      source = source.slice(0, from) + replacement + source.slice(to);
    }
    return { ...loaded, source };
  }
  return loaded;
} });
const prepareTools = await import("./archive-compaction-prepare.mjs");
const runTools = await import("./archive-compaction-run.mjs");
const { fingerprint, hashEntries, filesUnder, REPLAY_PHASES } = await import("./persistent-history-prepare.mjs");
const { hashFile } = await import("./remaining-harness-delivery-prepare.mjs");
const { BASE, KINDS } = await import("./c1-datasets.mjs");
hooks.deregister();
const { RESULT_ROOT, GROUPS, prepare, verifyManifest, verifyScene, installScenePackages, runtimeFiles, assertPackages } = prepareTools;
const { admission, validationGate, command } = runTools;
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
const json = (file, value) => write(file, `${JSON.stringify(value)}\n`);
const manifestFile = path.join(RESULT_ROOT, "manifest.json");
let manifest, validation, baselineInventoryBytes, stageABytes;

function sqlFile(file, sql) {
  const database = new DatabaseSync(file); try { database.exec(sql); } finally { database.close(); }
}
function seedTracking(database) {
  const template = new DatabaseSync(":memory:");
  try {
    for (const table of ["source_files", "archive_segments", "rate_limit_observations", "quota_usage_sources"]) template.exec(`CREATE TABLE ${table}(id INTEGER)`);
    template.exec("CREATE TABLE store_meta(key TEXT,value TEXT)");
    ensureHistoryProjectionTracking(template);
    for (const row of template.prepare(`SELECT sql FROM sqlite_schema WHERE
      (type='table' AND name IN ('usage_history_projection_inputs','usage_history_projection_batches')) OR
      (type='trigger' AND tbl_name IN ('archive_segments','store_meta')) ORDER BY type, name`).all()) database.exec(row.sql);
    database.exec("INSERT INTO usage_history_projection_inputs VALUES(1,1,'seed-instance','seed-token',7,3)");
  } finally { template.close(); }
}
function seedSnapshot(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all().map(row => ({ ...row }));
    return { schema, tables: Object.fromEntries(schema.filter(row => row.type === "table").map(row => [row.name,
      database.prepare(`SELECT rowid,* FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(record => ({ ...record }))])) };
  } finally { database.close(); }
}
function env(t, variant = "baseline") {
  const values = { C1_ARCHIVE_PROFILE: "compaction", C1_RESULT_ROOT: RESULT_ROOT, C1_MANIFEST: manifestFile,
    C1_RUNTIME_SPEC: manifest[`${variant}File`], C1_ARCHIVE_VALIDATION: manifest.validationFile };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

before(async () => {
  assert.notEqual(root, path.resolve("."));
  await write(path.join(root, "tool-anchor.mjs"), "synthetic measurement tool");
  for (const file of ["archive-verification-prepare.mjs", "archive-verification-run.mjs", "archive-verification-telemetry.mjs",
    "archive-compaction-prepare.mjs", "archive-compaction-run.mjs", "archive-compaction-tools.test.mjs",
    "archive-compaction-packages.mjs", "archive-compaction-upgrade.mjs"]) {
    await write(path.join(root, "experiments/architecture-20261101", file), `synthetic ${file}`);
  }
  for (const file of ["src/app.js", "public/app.js", "package.json", "package-lock.json"]) await write(path.join(root, file), `baseline ${file}`);
  const native = path.join(root, "native/windows-source-proof"), sources = ["Cargo.toml", "Cargo.lock", "build.ps1", "src/main.rs"];
  for (const file of sources) await write(path.join(native, file), `synthetic native ${file}`);
  await write(path.join(native, "bin/windows-source-proof.exe"), "synthetic native executable, never launched");
  const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async file => [file, await hashFile(path.join(native, file))])));
  await json(path.join(native, "bin/windows-source-proof.build.json"), { format: 1, artifact: "windows-source-proof.exe", sourceSha256,
    sha256: await hashFile(path.join(native, "bin/windows-source-proof.exe")) });
  await write(path.join(native, "target/ignored.cache"), "not shipped");
  const oldRoot = path.join(root, "output/archive-verification-reuse-20261108"), hashes = {};
  const directory = path.join(oldRoot, "versions/candidate");
  for (const file of await runtimeFiles()) {
    await write(path.join(directory, file), await fs.readFile(path.join(root, file))); hashes[file] = await hashFile(path.join(directory, file));
  }
  await json(path.join(oldRoot, "candidate.json"), { directory, hashes, commit: "workspace-explicit-freeze" });
  await json(path.join(RESULT_ROOT, "baseline.json"), { commit: "9fae129-fixture", files: Object.entries(hashes).map(([file, sha256]) => ({ file, sha256 })) });
  baselineInventoryBytes = await fs.readFile(path.join(RESULT_ROOT, "baseline.json"));
  await write(path.join(root, "src/new-candidate-module.js"), "new dynamic inventory entry");
  const packages = [], datasets = [];
  for (const [label, count] of [["current", 1], ["year", 4], ["two-years", 8]]) {
    const datasetRoot = path.join(BASE, "datasets", label), home = path.join(datasetRoot, "home");
    for (const kind of KINDS) await write(path.join(home, `${kind}.json`), `immutable ${label}/${kind}`);
    for (let index = 0; index < count; index++) {
      const originalFile = path.join(datasetRoot, "archive-build", `segment-${index}.sqlite`);
      const copiedFile = label === "two-years" && index === 0 ? path.join(RESULT_ROOT, "stage-a/segment-0.sqlite") : path.join(RESULT_ROOT, "packages", label, `segment-${index}.sqlite`);
      await fs.mkdir(path.dirname(originalFile), { recursive: true }); await fs.mkdir(path.dirname(copiedFile), { recursive: true });
      const schema = `CREATE TABLE events(id INTEGER PRIMARY KEY,total INTEGER); INSERT INTO events VALUES (1,${index + 1});
        CREATE TABLE auxiliary(value TEXT); INSERT INTO auxiliary VALUES ('${label}-${index}'); CREATE TABLE padding(data BLOB); PRAGMA user_version=24;`;
      sqlFile(originalFile, `${schema} INSERT INTO padding VALUES(zeroblob(65536)); DELETE FROM padding;`);
      sqlFile(copiedFile, schema);
      const previous = { databaseFile: originalFile, sha256: await hashFile(originalFile), bytes: (await fs.stat(originalFile)).size };
      const next = { databaseFile: copiedFile, sha256: await hashFile(copiedFile), bytes: (await fs.stat(copiedFile)).size };
      const tables = compareHistoryDatabases(originalFile, copiedFile);
      for (const entry of [previous, next]) await json(entry.databaseFile.replace(/\.sqlite$/, ".manifest.json"), {
        formatVersion: 1, schemaVersion: 24, database: { sha256: entry.sha256, bytes: entry.bytes },
        tables: Object.fromEntries(tables.map(row => [row.table, { rows: row.rows, sha256: row.sha256 }])),
        pricing: { catalog: { version: "frozen-price" } }, serviceTierEvidence: { snapshot: "frozen-evidence" }, quickCheck: "ok", foreignKeys: "ok",
      });
      const evidenceFile = path.join(RESULT_ROOT, "evidence", `${label}-${index}.json`), measurementFile = `${evidenceFile}.measurement.json`;
      await json(measurementFile, { passed: true, synthetic: true });
      await json(evidenceFile, { passed: true, previous, next, tables, measurementFile, measurementSha256: await hashFile(measurementFile) });
      packages.push({ label, index, previous, next, evidenceFile, evidenceSha256: await hashFile(evidenceFile) });
    }
    const seed = path.join(datasetRoot, "seed-mixed/usage-index.sqlite"); await fs.mkdir(path.dirname(seed), { recursive: true });
    sqlFile(seed, `CREATE TABLE archive_segments(segment_id TEXT PRIMARY KEY,database_path TEXT,database_sha256 TEXT,start_ms INTEGER,end_ms INTEGER,event_count INTEGER);
      CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY,source_path TEXT,timestamp_ms INTEGER,total INTEGER,input INTEGER,cached INTEGER,output INTEGER,reasoning INTEGER);
      INSERT INTO events VALUES (-7,'untouched-hot',1,10,8,0,2,0);
      CREATE TABLE quota_usage_sources(value TEXT); INSERT INTO quota_usage_sources(rowid,value) VALUES(-9,'untouched quota');`);
    const database = new DatabaseSync(seed);
    try {
      const rows = packages.filter(row => row.label === label);
      for (const row of rows) database.prepare("INSERT INTO archive_segments VALUES(?,?,?,?,?,?)").run(row.previous.sha256, row.previous.databaseFile, row.previous.sha256, row.index * 10, row.index * 10 + 10, 1);
      const set = database.prepare("INSERT INTO store_meta VALUES(?,?)");
      set.run("history_archive_event_authority", JSON.stringify({ formatVersion: 1, segmentIds: rows.map(row => row.previous.sha256) }));
      set.run("history_archive_event_revisions", JSON.stringify({ formatVersion: 1, revisions: [{ segmentId: rows[0].previous.sha256,
        databaseSha256: rows[0].previous.sha256, sourceIdentity: { path: "untouched-source" }, removed: [], added: [{ payload: rows[0].previous.sha256 }] }] }));
      set.run("pricing-and-evidence", "untouched pricing/evidence");
      set.run("official_quota_observations", "untouched official quota evidence");
      set.run("quota_source_log_evidence", "untouched source log evidence");
      if (label === "two-years") seedTracking(database);
    } finally { database.close(); }
    const hot = path.join(datasetRoot, "seed-state/usage-index.sqlite"); await fs.mkdir(path.dirname(hot)); await fs.copyFile(seed, hot);
    await write(path.join(datasetRoot, "seed-mixed/pricing.json"), "unchanged price file");
    await json(path.join(datasetRoot, "dataset.json"), { label, root: datasetRoot, home });
    const files = [path.join(datasetRoot, "dataset.json")];
    for (const folder of ["home", "seed-state", "seed-mixed", "archive-build"]) files.push(...(await filesUnder(path.join(datasetRoot, folder))).map(file => path.join(datasetRoot, folder, file)));
    const entries = await hashEntries(files);
    datasets.push({ label, root: datasetRoot, home, homeFiles: (await filesUnder(home)).map(file => path.join(home, file)), entries, fingerprint: fingerprint(entries) });
  }
  await json(path.join(oldRoot, "manifest.json"), { candidateFile: path.join(oldRoot, "candidate.json"), candidateFingerprint: fingerprint(hashes), datasets });
  await json(path.join(RESULT_ROOT, "packages.json"), { passed: true, packages });
  stageABytes = await fs.readFile(path.join(RESULT_ROOT, "stage-a/segment-0.sqlite"));
  manifest = await prepare();
  const log = path.join(RESULT_ROOT, "validation.log"); await write(log, "synthetic B checks passed");
  validation = { passed: true, runtimeFingerprint: manifest.candidateFingerprint, checks: [{ name: "tiny-B", command: "synthetic selfcheck", exitCode: 0, log, sha256: await hashFile(log) }] };
  await json(manifest.validationFile, validation);
});

test("prepare retains old artifacts, freezes dynamic complete inventory and fixes exactly ten groups / thirteen packages", async () => {
  await verifyManifest(manifestFile);
  assert.equal(GROUPS.length, 10); assert.equal(manifest.compactPackages.length, 13);
  assert.deepEqual(await fs.readFile(path.join(RESULT_ROOT, "baseline.json")), baselineInventoryBytes);
  assert.deepEqual(await fs.readFile(path.join(RESULT_ROOT, "stage-a/segment-0.sqlite")), stageABytes);
  const candidate = JSON.parse(await fs.readFile(manifest.candidateFile, "utf8"));
  assert.ok(candidate.hashes[path.join("src", "new-candidate-module.js")]);
  assert.ok(!Object.keys(candidate.hashes).some(file => file.includes("target")));
  assert.ok(manifest.tools.some(row => row.file.endsWith("archive-compaction-packages.mjs")));
  assert.ok(manifest.tools.some(row => row.file.endsWith("archive-compaction-upgrade.mjs")));
  await assert.rejects(prepare(), /Missing expected rejection/);
  assert.throws(() => assertPackages(manifest.compactPackages.slice(1), manifest.datasets, RESULT_ROOT), /13 packages/);
  const replaced = structuredClone(manifest.compactPackages); replaced.at(-8).next.databaseFile = path.join(RESULT_ROOT, "rebuilt-stage-a.sqlite");
  assert.throws(() => assertPackages(replaced, manifest.datasets, RESULT_ROOT), /reuse Stage A/);
  const added = path.join(root, "src/late-module.js"); await write(added, "late change");
  try { await assert.rejects(verifyManifest(manifestFile)); } finally { await fs.rm(added); }
});

test("B admission binds runtime and logs, requires restored predecessors and both scale gates", async () => {
  await validationGate(manifest.validationFile, manifest);
  for (const changed of [{ ...validation, passed: false }, { ...validation, runtimeFingerprint: "old" },
    { ...validation, checks: [] }, { ...validation, checks: [...validation.checks, ...validation.checks] }]) {
    await json(manifest.validationFile, changed); await assert.rejects(validationGate(manifest.validationFile, manifest));
  }
  await json(manifest.validationFile, validation);
  await write(validation.checks[0].log, "same path, changed log");
  await assert.rejects(validationGate(manifest.validationFile, manifest), /drift/);
  await write(validation.checks[0].log, "synthetic B checks passed");
  await admission(manifest, GROUPS[0], manifestFile);
  await assert.rejects(admission(manifest, GROUPS[1], manifestFile), { code: "ENOENT" });
  const manifestSha256 = await hashFile(manifestFile);
  for (const group of GROUPS) await json(path.join(RESULT_ROOT, "datasets", group.label, `scene-${group.name}/result.json`), {
    passed: true, rawRestored: true, evidence: { manifestSha256, runtimeFingerprint: manifest[`${group.variant}Fingerprint`], candidateFingerprint: manifest.candidateFingerprint },
  });
  await assert.rejects(admission(manifest, GROUPS[4], manifestFile), { code: "ENOENT" });
  for (const [stage, group] of [["current", GROUPS[4]], ["year", GROUPS[8]]]) {
    const file = path.join(RESULT_ROOT, `analysis-${stage}.json`), gate = { stage, passed: true, manifestSha256, candidateFingerprint: manifest.candidateFingerprint };
    await json(file, { ...gate, passed: false }); await assert.rejects(admission(manifest, group, manifestFile), /previous scale/);
    await json(file, { ...gate, manifestSha256: "stale" }); await assert.rejects(admission(manifest, group, manifestFile));
    await json(file, gate); await admission(manifest, group, manifestFile);
  }
  const first = path.join(RESULT_ROOT, "datasets/current/scene-hot-baseline/result.json"), saved = await fs.readFile(first);
  await json(first, { passed: true, rawRestored: false });
  try { await assert.rejects(admission(manifest, GROUPS[1], manifestFile), /source restore/); } finally { await fs.writeFile(first, saved); }
});

test("scene preflight verifies original/new bytes and candidate replays the paired baseline phase clocks", async (t) => {
  env(t);
  const baseline = await verifyScene(manifestFile, "current", "hot", "hot-baseline", manifest.baselineFile);
  assert.equal(baseline.clockReplay, null);
  const input = manifest.datasets[0], file = input.homeFiles[0], saved = await fs.readFile(file);
  await fs.writeFile(file, "mutated raw input");
  try { await assert.rejects(verifyScene(manifestFile, "current", "hot", "hot-baseline", manifest.baselineFile), /drift/); } finally { await fs.writeFile(file, saved); }
  const row = manifest.compactPackages[0], bytes = await fs.readFile(row.next.databaseFile);
  await fs.writeFile(row.next.databaseFile, Buffer.alloc(bytes.length));
  try { await assert.rejects(verifyScene(manifestFile, "current", "hot", "hot-baseline", manifest.baselineFile), /drift/); } finally { await fs.writeFile(row.next.databaseFile, bytes); }
  const proof = JSON.parse(await fs.readFile(row.evidenceFile, "utf8"));
  const measurement = await fs.readFile(proof.measurementFile); await fs.writeFile(proof.measurementFile, "changed measurement");
  try { await assert.rejects(verifyScene(manifestFile, "current", "hot", "hot-baseline", manifest.baselineFile), /drift/); } finally { await fs.writeFile(proof.measurementFile, measurement); }
  const directory = path.join(RESULT_ROOT, "datasets/current/scene-hot-baseline"), state = path.join(RESULT_ROOT, "datasets/current/state-scene-hot-baseline");
  for (const phase of REPLAY_PHASES) await json(path.join(directory, `${phase}.json`), { metadata: { modelUsageAsOf: "2026-11-08T01:02:03.000Z" }, summary: { range: { calendarZone: "utc" } } });
  await fs.mkdir(state); await fs.copyFile(path.join(input.root, "seed-state/usage-index.sqlite"), path.join(state, "usage-index.sqlite"));
  const database = new DatabaseSync(path.join(state, "usage-index.sqlite")), changes = [], plans = [];
  try {
    for (const [index, kind] of KINDS.entries()) {
      const time = 1794099723000 + index * 1000, filePath = path.join(input.home, `${kind}.json`);
      database.prepare("INSERT INTO events(source_path,timestamp_ms,total,input,cached,output,reasoning) VALUES(?,?,160,140,30,20,?)")
        .run(filePath, time, ["codex", "zcode", "opencode", "workbuddy"].includes(kind) ? 5 : 0);
      changes.push({ name: `append-${kind}`, startedAtMs: time, landedAtMs: time + 1 }); plans.push({ kind, filePath });
    }
  } finally { database.close(); }
  const resultFile = path.join(directory, "result.json"), result = JSON.parse(await fs.readFile(resultFile, "utf8"));
  await json(resultFile, { ...result, changes }); await json(path.join(directory, "mutation-plans.json"), plans);
  process.env.C1_RUNTIME_SPEC = manifest.candidateFile;
  const evidence = await verifyScene(manifestFile, "current", "hot", "hot-candidate", manifest.candidateFile);
  assert.deepEqual(evidence.clockReplay.phases.map(row => row.phase), REPLAY_PHASES);
  assert.equal(evidence.clockReplay.mutations.length, 6);
  assert.equal(evidence.clockReplayFingerprint, fingerprint(evidence.clockReplay));
  await assert.rejects(verifyScene(manifestFile, "current", "hot", "hot-candidate", manifest.baselineFile));
  const spec = command(manifest, GROUPS[1], manifestFile);
  assert.deepEqual(spec.args.slice(1), ["scene", "current", "hot", "hot-candidate"]);
  assert.equal(spec.env.C1_ARCHIVE_PROFILE, "compaction"); assert.equal(spec.env.C1_RUNTIME_SPEC, manifest.candidateFile);
  assert.equal(spec.env.C1_MANIFEST, manifestFile); assert.equal(spec.env.C1_ARCHIVE_TRACE, "1");
});

test("installation preserves facts and real seed triggers, changing only references and tracking revision", async (t) => {
  env(t, "candidate");
  for (const name of ["hot-baseline", "hot-candidate", "mixed-baseline"]) {
    assert.equal(await installScenePackages(manifestFile, "current", path.join(RESULT_ROOT, "datasets/current", `state-scene-${name}`)), null);
  }
  for (const label of ["current", "two-years"]) {
    const input = manifest.datasets.find(row => row.label === label), seed = path.join(input.root, "seed-mixed/usage-index.sqlite");
    const beforeSeed = await fs.readFile(seed), state = path.join(RESULT_ROOT, "datasets", label, "state-scene-mixed-candidate");
    const file = path.join(state, "usage-index.sqlite");
    await assert.rejects(installScenePackages(manifestFile, label, path.dirname(seed)), /isolated scene/);
    await fs.mkdir(state); await fs.copyFile(seed, file);
    const priceFile = path.join(state, "pricing.json"); await fs.copyFile(path.join(input.root, "seed-mixed/pricing.json"), priceFile);
    const price = await fs.readFile(priceFile), before = seedSnapshot(file);
    const packages = manifest.compactPackages.filter(row => row.label === label), mapping = new Map(packages.map(row => [row.previous.sha256, row.next]));
    const expected = structuredClone(before);
    for (const record of expected.tables.archive_segments) {
      const next = mapping.get(record.segment_id);
      record.segment_id = record.database_sha256 = next.sha256; record.database_path = next.databaseFile;
    }
    for (const record of expected.tables.store_meta) {
      if (record.key === "history_archive_event_authority") {
        const value = JSON.parse(record.value); value.segmentIds = value.segmentIds.map(id => mapping.get(id).sha256); record.value = JSON.stringify(value);
      } else if (record.key === "history_archive_event_revisions") {
        const value = JSON.parse(record.value);
        for (const revision of value.revisions) revision.segmentId = revision.databaseSha256 = mapping.get(revision.segmentId).sha256;
        record.value = JSON.stringify(value);
      }
    }
    const triggers = before.schema.filter(row => row.type === "trigger");
    assert.equal(triggers.length, label === "two-years" ? 6 : 0);
    if (label === "two-years") expected.tables.usage_history_projection_inputs[0].aux_revision += 10;
    const installed = await installScenePackages(manifestFile, label, state), after = seedSnapshot(file);
    assert.equal(installed.packages, packages.length); assert.equal(installed.projectionCount, 0);
    assert.deepEqual(after, expected);
    assert.deepEqual(await fs.readFile(seed), beforeSeed); assert.deepEqual(await fs.readFile(priceFile), price);
    assert.deepEqual((await fs.readdir(state)).sort(), ["pricing.json", "usage-index.sqlite"]);
    await assert.rejects(installScenePackages(manifestFile, label, state), /unmapped seed archive/);
    assert.deepEqual(seedSnapshot(file), after);
  }
});

test("installation rejects unknown and spoofed reference triggers before changing the seed copy", async (t) => {
  env(t, "candidate");
  const input = manifest.datasets.find(row => row.label === "year"), seed = path.join(input.root, "seed-mixed/usage-index.sqlite");
  const state = path.join(RESULT_ROOT, "datasets/year/state-scene-mixed-candidate"), file = path.join(state, "usage-index.sqlite");
  await fs.mkdir(state);
  for (const name of ["unexpected_archive_trigger", "usage_history_input_archive_segments_UPDATE"]) {
    await fs.copyFile(seed, file);
    sqlFile(file, `CREATE TRIGGER ${name} AFTER UPDATE ON archive_segments BEGIN UPDATE events SET total=0; END`);
    const before = await fs.readFile(file);
    await assert.rejects(installScenePackages(manifestFile, "year", state), /unexpected seed reference trigger/);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readdir(state), ["usage-index.sqlite"]);
  }
});
