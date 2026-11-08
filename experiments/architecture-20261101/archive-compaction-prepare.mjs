import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ROOT, BASE, inside, read, save } from "./c1-datasets.mjs";
import { GROUPS, assertMatrix } from "./archive-verification-prepare.mjs";
import {
  CONDITIONS, fingerprint, filesUnder, hashEntries, verifyEntries, verifyFrozenRuntime,
  toolReceipt, environment, buildClockReplay,
} from "./persistent-history-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";

export { GROUPS, assertMatrix };
export const RESULT_ROOT = path.join(ROOT, "output/archive-compaction-20261108");
export const REUSED_MANIFEST = path.join(ROOT, "output/archive-verification-reuse-20261108/manifest.json");
const COUNTS = { current: 1, year: 4, "two-years": 8 };
const SHA = /^[a-f0-9]{64}$/;
const companion = file => { const parsed = path.parse(file); return path.join(parsed.dir, `${parsed.name}.manifest.json`); };
const statePath = (manifest, group) => path.join(manifest.resultRoot, "datasets", group.label, `state-scene-${group.name}`);

export async function runtimeFiles(root = ROOT) {
  // Cargo's disposable build cache is not part of the shipped native runtime.
  async function nativeFiles(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), `unexpected native link: ${entry.name}`);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "target") result.push(...await nativeFiles(file));
      else if (entry.isFile()) result.push(path.relative(root, file));
    }
    return result;
  }
  return [...(await filesUnder(path.join(root, "src"))).map(file => path.join("src", file)),
    ...(await filesUnder(path.join(root, "public"))).map(file => path.join("public", file)),
    "package.json", "package-lock.json", ...await nativeFiles(path.join(root, "native"))].sort();
}

async function nativeBuild() {
  const directory = path.join(ROOT, "native/windows-source-proof");
  const receipt = await read(path.join(directory, "bin/windows-source-proof.build.json"));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.artifact, "windows-source-proof.exe");
  const sources = ["Cargo.toml", "Cargo.lock", "build.ps1",
    ...(await filesUnder(path.join(directory, "src"))).filter(file => file.endsWith(".rs")).map(file => `src/${file.replaceAll("\\", "/")}`)];
  assert.deepEqual(Object.keys(receipt.sourceSha256).sort(), sources.sort(), "native build source coverage");
  await verifyEntries(sources.map(file => ({ file: path.join(directory, file), sha256: receipt.sourceSha256[file] })));
  await verifyEntries([{ file: path.join(directory, "bin", receipt.artifact), sha256: receipt.sha256 }]);
}

export async function tools() {
  const shared = await toolReceipt();
  const extra = ["archive-verification-prepare.mjs", "archive-verification-run.mjs", "archive-verification-telemetry.mjs",
    "archive-compaction-prepare.mjs", "archive-compaction-run.mjs", "archive-compaction-tools.test.mjs",
    "archive-compaction-packages.mjs", "archive-compaction-upgrade.mjs"];
  const entries = [...shared.entries, ...await hashEntries(extra.map(file => path.join(ROOT, "experiments/architecture-20261101", file)))];
  return { entries, sha256: fingerprint(entries) };
}

export function assertPackages(packages, datasets, resultRoot) {
  assert.equal(packages.length, 13, "exactly 13 packages, including the Stage A package");
  const previous = new Set(), next = new Set(), ids = new Set();
  for (const [label, count] of Object.entries(COUNTS)) {
    const rows = packages.filter(row => row.label === label).sort((a, b) => a.index - b.index);
    assert.deepEqual(rows.map(row => row.index), Array.from({ length: count }, (_, index) => index), `${label}: package indices`);
    const input = datasets.find(row => row.label === label); assert.ok(input);
    for (const row of rows) {
      const expected = path.join(input.root, "archive-build", `segment-${row.index}.sqlite`);
      assert.equal(row.previous.databaseFile, expected, "package must replace its frozen original");
      assert.equal(input.entries.find(entry => entry.file === expected)?.sha256, row.previous.sha256);
      for (const entry of [row.previous, row.next]) {
        assert.ok(path.isAbsolute(entry.databaseFile)); assert.match(entry.sha256, SHA);
        assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
        assert.ok(!ids.has(entry.sha256), "duplicate/overlapping package identity"); ids.add(entry.sha256);
      }
      assert.ok(!previous.has(expected) && !next.has(row.next.databaseFile), "package reused more than once");
      previous.add(expected); next.add(row.next.databaseFile);
      assert.ok(inside(resultRoot, row.next.databaseFile), "new package must remain in the compaction result tree");
      assert.ok(inside(resultRoot, row.evidenceFile)); assert.match(row.evidenceSha256, SHA);
      if (label === "two-years" && row.index === 0) {
        assert.equal(row.next.databaseFile, path.join(resultRoot, "stage-a/segment-0.sqlite"), "reuse Stage A, never rebuild it");
      }
    }
  }
}

async function verifyPackage(row, entries) {
  const proofFiles = [row.previous.databaseFile, companion(row.previous.databaseFile),
    row.next.databaseFile, companion(row.next.databaseFile), row.evidenceFile];
  const expected = proofFiles.map(file => { const entry = entries.find(entry => entry.file === file); assert.ok(entry, `missing package file hash: ${file}`); return entry; });
  await verifyEntries(expected);
  assert.equal(expected[0].sha256, row.previous.sha256);
  assert.equal(expected[2].sha256, row.next.sha256);
  assert.equal(expected[4].sha256, row.evidenceSha256);
  const evidence = await read(row.evidenceFile);
  assert.equal(evidence.passed, true, "full-table equivalence must have passed");
  assert.deepEqual(evidence.previous, row.previous); assert.deepEqual(evidence.next, row.next);
  assert.ok(path.isAbsolute(evidence.measurementFile)); assert.match(evidence.measurementSha256, SHA);
  await verifyEntries([{ file: evidence.measurementFile, sha256: evidence.measurementSha256 }]);
  const manifests = [];
  for (const entry of [row.previous, row.next]) {
    assert.equal((await stat(entry.databaseFile)).size, entry.bytes, "package byte count changed");
    const manifest = await read(companion(entry.databaseFile)); manifests.push(manifest);
    assert.equal(manifest.database.sha256, entry.sha256); assert.equal(manifest.database.bytes, entry.bytes);
  }
  for (const field of ["formatVersion", "schemaVersion", "pricingVersion", "pricingCheckedAt", "pricing", "serviceTierEvidence", "tables", "quickCheck", "foreignKeys"]) {
    assert.deepEqual(manifests[1][field], manifests[0][field], `package ${field} changed`);
  }
  assert.ok(Array.isArray(evidence.tables) && evidence.tables.length, "missing all-table proof");
  const database = new DatabaseSync(row.next.databaseFile, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "delete", "package must be standalone");
    const tables = database.prepare("PRAGMA table_list").all().filter(table => table.schema === "main" && table.name !== "sqlite_schema");
    assert.ok(tables.every(table => table.type === "table" || table.type === "view"), "unsupported package table");
    assert.deepEqual(evidence.tables.map(proof => proof.table).sort(), tables.filter(table => table.type === "table").map(table => table.name).sort(), "proof omits or duplicates a table");
    for (const proof of evidence.tables) {
      assert.ok(Number.isSafeInteger(proof.rows) && proof.rows >= 0); assert.match(proof.sha256, SHA);
      assert.equal(proof.rowid, tables.find(table => table.name === proof.table).wr === 0);
    }
  } finally { database.close(); }
}

export async function prepare() {
  for (const name of ["manifest.json", "candidate.json", "baseline-runtime.json", "versions/candidate"]) {
    await assert.rejects(stat(path.join(RESULT_ROOT, name)), { code: "ENOENT" });
  }
  const reused = await read(REUSED_MANIFEST), baselineInventoryFile = path.join(RESULT_ROOT, "baseline.json");
  const inventory = await read(baselineInventoryFile), prior = await read(reused.candidateFile);
  assert.ok(inventory.commit.startsWith("9fae129"), "the baseline must be the agreed 9fae129 commit");
  assert.equal(fingerprint(prior.hashes), reused.candidateFingerprint); await verifyFrozenRuntime(prior);
  const normalized = Object.fromEntries(Object.entries(prior.hashes).map(([file, hash]) => [path.normalize(file), hash]));
  assert.ok(inventory.files.length);
  for (const entry of inventory.files) assert.equal(normalized[path.normalize(entry.file)], entry.sha256, `baseline commit mismatch: ${entry.file}`);
  const datasets = Object.keys(COUNTS).map(label => { const input = reused.datasets.find(row => row.label === label); assert.ok(input); assert.equal(fingerprint(input.entries), input.fingerprint); return input; });
  const packagesFile = path.join(RESULT_ROOT, "packages.json"), packages = await read(packagesFile);
  assert.equal(packages.passed, true); assertPackages(packages.packages, datasets, RESULT_ROOT);
  const packageEntries = [];
  for (const row of packages.packages) {
    const input = datasets.find(input => input.label === row.label);
    const oldManifest = input.entries.find(entry => entry.file === companion(row.previous.databaseFile));
    assert.ok(oldManifest, "original manifest is absent from the frozen inputs");
    const entries = [{ file: row.previous.databaseFile, sha256: row.previous.sha256 }, oldManifest,
      { file: row.next.databaseFile, sha256: row.next.sha256 },
      ...await hashEntries([companion(row.next.databaseFile)]), { file: row.evidenceFile, sha256: row.evidenceSha256 }];
    await verifyPackage(row, entries); packageEntries.push(...entries);
  }
  await nativeBuild();
  const files = await runtimeFiles(), workspace = await hashEntries(files.map(file => path.join(ROOT, file)));
  const directory = path.join(RESULT_ROOT, "versions/candidate"), hashes = {};
  await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory);
  for (const file of files) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(ROOT, file), target);
    hashes[file] = await hashFile(target);
  }
  await verifyEntries(workspace); assert.deepEqual(await runtimeFiles(), files);
  for (const entry of workspace) assert.equal(hashes[path.relative(ROOT, entry.file)], entry.sha256);
  const candidate = { directory, hashes, commit: "workspace-explicit-freeze", frozenAt: new Date().toISOString() };
  await verifyFrozenRuntime(candidate);
  const baselineFile = path.join(RESULT_ROOT, "baseline-runtime.json"), candidateFile = path.join(RESULT_ROOT, "candidate.json");
  await save(baselineFile, { ...prior, commit: inventory.commit, reusedFrom: reused.candidateFile });
  await save(candidateFile, candidate);
  const receipt = await tools();
  const manifest = { version: 1, kind: "archive-compaction", resultRoot: RESULT_ROOT, dataRoot: BASE,
    baselineFile, baselineFingerprint: fingerprint(prior.hashes), candidateFile, candidateFingerprint: fingerprint(hashes),
    runtimeSpecs: await hashEntries([baselineFile, candidateFile]), workspace, tools: receipt.entries, toolsFingerprint: receipt.sha256,
    runtime: await environment(), conditions: CONDITIONS, datasets, groups: GROUPS, maximumGroups: 10,
    reusedManifest: { file: REUSED_MANIFEST, sha256: await hashFile(REUSED_MANIFEST) },
    baselineInventory: { file: baselineInventoryFile, sha256: await hashFile(baselineInventoryFile) },
    packagesFile, packagesSha256: await hashFile(packagesFile), compactPackages: packages.packages, packageEntries,
    validationFile: path.join(RESULT_ROOT, "validation.json"), createdAt: new Date().toISOString() };
  await save(path.join(RESULT_ROOT, "manifest.json"), manifest);
  return manifest;
}

export async function verifyManifest(manifestFile) {
  const manifest = await read(manifestFile);
  assert.equal(manifest.kind, "archive-compaction"); assert.equal(manifest.version, 1);
  assert.equal(manifest.maximumGroups, 10); assertMatrix(manifest.groups);
  assert.equal(manifest.resultRoot, RESULT_ROOT); assert.equal(manifest.dataRoot, BASE);
  assert.equal(path.resolve(manifestFile), path.join(RESULT_ROOT, "manifest.json"));
  assert.deepEqual(manifest.conditions, CONDITIONS);
  await verifyEntries([manifest.reusedManifest, manifest.baselineInventory, { file: manifest.packagesFile, sha256: manifest.packagesSha256 }]);
  const reused = await read(manifest.reusedManifest.file), inventory = await read(manifest.baselineInventory.file);
  assert.ok(inventory.commit.startsWith("9fae129"));
  assert.deepEqual(manifest.datasets, Object.keys(COUNTS).map(label => reused.datasets.find(row => row.label === label)));
  const packages = await read(manifest.packagesFile); assert.equal(packages.passed, true);
  assert.deepEqual(manifest.compactPackages, packages.packages); assertPackages(manifest.compactPackages, manifest.datasets, manifest.resultRoot);
  assert.equal(fingerprint(manifest.tools), manifest.toolsFingerprint); await verifyEntries(manifest.tools);
  assert.deepEqual((await tools()).entries, manifest.tools, "measurement tool inventory changed");
  assert.deepEqual(await runtimeFiles(), manifest.workspace.map(entry => path.relative(ROOT, entry.file)));
  await verifyEntries(manifest.workspace); await verifyEntries(manifest.runtimeSpecs);
  for (const variant of ["baseline", "candidate"]) {
    const spec = await read(manifest[`${variant}File`]); await verifyFrozenRuntime(spec);
    assert.equal(fingerprint(spec.hashes), manifest[`${variant}Fingerprint`]);
    if (variant === "baseline") {
      assert.equal(spec.commit, inventory.commit); assert.equal(fingerprint(spec.hashes), reused.candidateFingerprint);
      const normalized = Object.fromEntries(Object.entries(spec.hashes).map(([file, hash]) => [path.normalize(file), hash]));
      for (const entry of inventory.files) assert.equal(normalized[path.normalize(entry.file)], entry.sha256);
    } else for (const entry of manifest.workspace) assert.equal(spec.hashes[path.relative(ROOT, entry.file)], entry.sha256);
  }
  return manifest;
}

export async function verifyScene(manifestFile, label, layout, name, specFile) {
  const manifest = await verifyManifest(manifestFile);
  const group = manifest.groups.find(row => row.label === label && row.layout === layout && row.name === name);
  assert.ok(group, "scene is outside the fixed matrix");
  const { admission } = await import("./archive-compaction-run.mjs");
  await admission(manifest, group, manifestFile, process.env.C1_ARCHIVE_VALIDATION || manifest.validationFile);
  assert.equal(process.env.C1_ARCHIVE_PROFILE, "compaction");
  assert.equal(path.resolve(process.env.C1_RESULT_ROOT), manifest.resultRoot);
  assert.equal(path.resolve(specFile), manifest[`${group.variant}File`]);
  assert.deepEqual(await environment(), manifest.runtime);
  const input = manifest.datasets.find(row => row.label === label);
  assert.equal(fingerprint(input.entries), input.fingerprint); await verifyEntries(input.entries);
  assert.deepEqual((await filesUnder(input.home)).map(file => path.join(input.home, file)).sort(), [...input.homeFiles].sort());
  for (const folder of ["seed-state", "seed-mixed", "archive-build"]) {
    const directory = path.join(input.root, folder);
    assert.deepEqual((await filesUnder(directory)).map(file => path.join(directory, file)).sort(), input.entries.filter(entry => inside(directory, entry.file)).map(entry => entry.file).sort());
  }
  const packages = manifest.compactPackages.filter(row => row.label === label);
  // Both variants receive identical preflight hashing; only candidate mixed substitutes package references.
  for (const row of packages) await verifyPackage(row, manifest.packageEntries);
  let clockReplay = null;
  if (group.variant === "candidate") {
    const directory = path.join(manifest.resultRoot, "datasets", label, `scene-${layout}-baseline`);
    clockReplay = await buildClockReplay({ directory, queryDirectory: directory,
      finalStateFile: path.join(manifest.resultRoot, "datasets", label, `state-scene-${layout}-baseline`, "usage-index.sqlite") },
    path.join(input.root, "seed-state/usage-index.sqlite"));
  }
  return { manifestFile: path.resolve(manifestFile), manifestSha256: await hashFile(manifestFile), variant: group.variant,
    candidateFingerprint: manifest.candidateFingerprint, runtimeFingerprint: manifest[`${group.variant}Fingerprint`],
    inputFingerprint: input.fingerprint, packagesFingerprint: fingerprint(packages), conditions: manifest.conditions,
    clockReplay, clockReplayFingerprint: clockReplay && fingerprint(clockReplay) };
}

function assertSeedReferenceTriggers(database) {
  const allowed = new Map();
  const keys = "'history_archive_event_authority','history_archive_event_revisions','official_quota_observations','quota_source_log_evidence'";
  for (const table of ["archive_segments", "store_meta"]) for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    const name = `usage_history_input_${table}_${op}`;
    const refs = op === "UPDATE" ? ["OLD", "NEW"] : [op === "DELETE" ? "OLD" : "NEW"];
    const when = table === "store_meta" ? ` WHEN ${refs.map(ref => `${ref}.key IN (${keys})`).join(" OR ")}` : "";
    allowed.set(name, `CREATE TRIGGER ${name} AFTER ${op} ON ${table}${when} BEGIN UPDATE usage_history_projection_inputs SET aux_revision=aux_revision+1 WHERE singleton=1; END`);
  }
  // Preserve canonical invalidation triggers: rewriting references must advance their input revision.
  for (const trigger of database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('archive_segments','store_meta')").all()) {
    assert.ok(allowed.has(trigger.name), `unexpected seed reference trigger: ${trigger.name}`);
    assert.equal(trigger.sql.replace(/\s+/g, " ").trim(), allowed.get(trigger.name), `unexpected seed reference trigger definition: ${trigger.name}`);
  }
}

export async function installScenePackages(manifestFile, label, state) {
  const manifest = await read(manifestFile);
  assert.equal(manifest.kind, "archive-compaction"); assert.equal(manifest.resultRoot, RESULT_ROOT); assertMatrix(manifest.groups);
  const group = manifest.groups.find(row => row.label === label && statePath(manifest, row) === path.resolve(state));
  assert.ok(group, "package installation is restricted to an isolated scene state");
  if (group.variant !== "candidate" || group.layout !== "mixed") return null;
  assert.equal(process.env.C1_ARCHIVE_PROFILE, "compaction");
  assert.equal(path.resolve(process.env.C1_RUNTIME_SPEC), manifest.candidateFile);
  assert.equal(await realpath(state), path.resolve(state), "scene state must not alias original inputs");
  const databaseFile = path.join(state, "usage-index.sqlite"), info = await lstat(databaseFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "scene database must be an independent copy");
  const projectionFiles = async () => {
    try { return await filesUnder(path.join(state, "usage-index.sqlite.history-cache")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  assert.deepEqual(await projectionFiles(), [], "initial projectionCount must remain zero");
  await verifyEntries([{ file: manifest.packagesFile, sha256: manifest.packagesSha256 }]);
  const listed = await read(manifest.packagesFile); assert.equal(listed.passed, true);
  assert.deepEqual(manifest.compactPackages, listed.packages); assertPackages(listed.packages, manifest.datasets, manifest.resultRoot);
  const replacements = listed.packages.filter(row => row.label === label);
  for (const row of replacements) await verifyPackage(row, manifest.packageEntries);
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("BEGIN IMMEDIATE");
    const records = database.prepare("SELECT * FROM archive_segments").all();
    assert.equal(records.length, replacements.length, "seed registry differs from frozen package set");
    assertSeedReferenceTriggers(database);
    const mapping = new Map(replacements.map(row => [row.previous.sha256, row]));
    for (const record of records) {
      const row = mapping.get(record.segment_id); assert.ok(row, "unmapped seed archive");
      assert.equal(record.database_sha256, row.previous.sha256);
      assert.equal(path.resolve(record.database_path), row.previous.databaseFile);
    }
    const values = [];
    for (const key of ["history_archive_event_authority", "history_archive_event_revisions"]) {
      const stored = database.prepare("SELECT value FROM store_meta WHERE key=?").get(key);
      if (!stored) continue;
      const value = JSON.parse(stored.value); assert.equal(value.formatVersion, 1);
      if (key === "history_archive_event_authority") {
        assert.ok(Array.isArray(value.segmentIds));
        value.segmentIds = value.segmentIds.map(id => { assert.ok(mapping.has(id), "unknown authority identity"); return mapping.get(id).next.sha256; });
      } else {
        assert.ok(Array.isArray(value.revisions));
        for (const revision of value.revisions) {
          const row = mapping.get(revision.segmentId); assert.ok(row, "unknown revision identity");
          assert.equal(revision.databaseSha256, row.previous.sha256);
          revision.segmentId = revision.databaseSha256 = row.next.sha256;
        }
      }
      values.push([JSON.stringify(value), key]);
    }
    for (const row of replacements) database.prepare("UPDATE archive_segments SET segment_id=?,database_sha256=?,database_path=? WHERE segment_id=?")
      .run(row.next.sha256, row.next.sha256, row.next.databaseFile, row.previous.sha256);
    for (const [value, key] of values) database.prepare("UPDATE store_meta SET value=? WHERE key=?").run(value, key);
    assert.deepEqual(await projectionFiles(), [], "package installation created a projection");
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
  return { packages: replacements.length, projectionCount: 0, packagesFingerprint: fingerprint(replacements) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], "prepare", "prepare only after B and package construction are complete");
  const manifest = await prepare();
  console.log(JSON.stringify({ manifest: path.join(manifest.resultRoot, "manifest.json"), groups: manifest.groups.length }));
}
