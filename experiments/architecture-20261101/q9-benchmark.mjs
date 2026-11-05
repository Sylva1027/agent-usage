import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HERE = "experiments/architecture-20261101";
export const BASE = path.join(ROOT, "output/architecture-20261105/q9");
export const Q8_COMMIT = "46bd676b47b8f572319590fcd76e4c28e0f8fdb6";
export const Q6_MATRIX = path.join(ROOT, "output/architecture-20261105/q6/q6-20261105-d/matrix.json");
export const Q8_MATRIX = path.join(ROOT, "output/architecture-20261105/q8/matrix.json");
export const HELPER = "native/windows-source-proof/bin/windows-source-proof.exe";
export const SHARED = ["q6-performance-run.mjs", "q6-performance-prepare.mjs", "q6-performance-hook.mjs",
  "q5-fixture.mjs", "q5-summary-hook.mjs", "b2-page-diagnostic.mjs", "b2-attribution-resource.ps1",
  "q3-benchmark-support.mjs"].map((name) => `${HERE}/${name}`);
export const PLANNED = { services: 8, newSessions: 16, appends: 8, reopens: 4, emptyImports: 0 };
export const read = async (file) => JSON.parse(await readFile(file, "utf8"));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const save = (file, value, fresh = false) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: fresh ? "wx" : "w", flush: true });
const git = (...args) => execFileSync("git", args, { cwd: ROOT, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export async function absent(file) {
  await assert.rejects(stat(file), (e) => e.code === "ENOENT", `Retain existing attempt: ${file}`);
}
export function ordinaryAux(name) {
  assert.match(name, /^codex-q9-[a-z0-9-]+$/);
  const directory = path.join(os.homedir(), "AppData", "Local", "Temp", name);
  assert.match(directory, /^C:[\\/]/i);
  return directory;
}

export async function runtime(reference) {
  const pwsh = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command",
    "@{path=(Get-Process -Id $PID).Path;version=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true }));
  const playwright = process.env.ARCH_PLAYWRIGHT_MODULE || reference.playwright.file;
  const chromium = process.env.ARCH_CHROMIUM || reference.chromium.file;
  const packageFile = path.join(path.dirname(playwright), "package.json");
  return { node: { file: process.execPath, sha256: await hashFile(process.execPath), versions: process.versions },
    pwsh: { ...pwsh, sha256: await hashFile(pwsh.path) },
    playwright: { file: playwright, sha256: await hashFile(playwright), packageSha256: await hashFile(packageFile), version: (await read(packageFile)).version },
    chromium: { file: chromium, sha256: await hashFile(chromium) }, platform: process.platform, arch: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export async function freeze(variant) {
  assert.ok(["q8", "candidate"].includes(variant));
  assert.equal(git("rev-parse", "46bd676").toString().trim(), Q8_COMMIT, "Resolve the actual Q8 commit before freezing");
  const directory = path.join(BASE, "versions", variant);
  await absent(directory);
  const old = (await read(Q8_MATRIX)).versions.find((v) => v.variant === "candidate");
  const oldHashes = await read(old.hashesFile);
  assert.equal(await hashFile(old.nativeBinary), oldHashes[HELPER]);
  const runtimePaths = ["src", "public", "native", "package.json", "package-lock.json"];
  const files = (variant === "q8"
    ? git("ls-tree", "-r", "--name-only", Q8_COMMIT, "--", ...runtimePaths)
    : git("ls-files", "--cached", "--others", "--exclude-standard", "--", ...runtimePaths))
    .toString().trim().split(/\r?\n/).filter(Boolean);
  // Freeze the shared harness from the same Git tree; Main may keep editing its checkout.
  if (variant === "q8") files.push(...SHARED);
  const hashes = {};
  await mkdir(directory, { recursive: true });
  for (const relative of new Set(files)) {
    if (relative === HELPER) continue;
    const bytes = variant === "q8" ? git("show", `${Q8_COMMIT}:${relative}`) : await readFile(path.join(ROOT, relative));
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), bytes, { flag: "wx" });
    hashes[relative] = sha(bytes);
  }
  await mkdir(path.dirname(path.join(directory, HELPER)), { recursive: true });
  await copyFile(old.nativeBinary, path.join(directory, HELPER));
  hashes[HELPER] = oldHashes[HELPER];
  const currentRuntime = await runtime(old.runtime);
  assert.deepEqual(currentRuntime, old.runtime, "Node/pwsh/browser differ from Q8; review before benchmarking");
  const receipt = { variant, directory, nativeBinary: path.join(directory, HELPER), helperSha256: hashes[HELPER],
    hashesFile: path.join(BASE, `${variant}-hashes.json`), commit: variant === "q8" ? Q8_COMMIT : git("rev-parse", "HEAD").toString().trim(),
    source: variant === "q8" ? "git blobs" : "working tree", createdAt: new Date().toISOString(), runtime: currentRuntime };
  await save(receipt.hashesFile, hashes, true);
  await save(path.join(BASE, `${variant}-freeze.json`), receipt, true);
  console.log(JSON.stringify({ frozen: variant, files: Object.keys(hashes).length, directory, commit: receipt.commit, helperSha256: receipt.helperSha256 }));
}

export function cellsFor(q6, q8, auxiliary) {
  const cells = [];
  for (const fileCount of [2000, 20000]) for (const variant of ["q8", "candidate"]) {
    const template = q6.cells.find((c) => c.fileCount === fileCount && c.variant === "candidate");
    assert.ok(template, `Missing ${fileCount} Q6 seed`);
    cells.push({ ...structuredClone(template), id: `new-${fileCount}-${variant}`, suite: "new", variant,
      rounds: 0, fileCount, reopenCard: false, fixtureVariant: "candidate", diagnostic: false });
  }
  for (const proofMode of ["native", "sha"]) for (const variant of ["q8", "candidate"]) {
    const template = q8.cells.find((c) => c.proofMode === proofMode && c.variant === "candidate");
    assert.ok(template, `Missing Q8 ${proofMode} seed`);
    cells.push({ ...structuredClone(template), id: `refresh-${proofMode}-${variant}`, suite: "refresh", variant,
      rounds: 1, reopenCard: true, fixtureVariant: "candidate", diagnostic: false });
  }
  for (const cell of cells) {
    const directory = path.join(BASE, "formal", cell.id), stateDirectory = path.join(directory, "state");
    cell.directory = directory;
    cell.sourcePrepared = structuredClone(cell.prepared);
    cell.prepared = { ...cell.prepared, stateDirectory, databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
      importStoreFile: path.join(auxiliary, cell.id, "imports.json"), pricingFile: path.join(auxiliary, cell.id, "pricing.json"),
      automaticPricingFile: path.join(auxiliary, cell.id, "pricing-auto.json") };
  }
  return cells;
}
export function assertMatrix(matrix) {
  assert.deepEqual(matrix.planned, PLANNED);
  assert.equal(matrix.cells.length, 8);
  assert.equal(new Set(matrix.cells.map((c) => c.id)).size, 8);
  for (const size of [2000, 20000]) for (const version of ["q8", "candidate"])
    assert.equal(matrix.cells.filter((c) => c.suite === "new" && c.fileCount === size && c.variant === version && c.rounds === 0 && c.proofMode === "native" && !c.reopenCard).length, 1);
  for (const mode of ["native", "sha"]) for (const version of ["q8", "candidate"])
    assert.equal(matrix.cells.filter((c) => c.suite === "refresh" && c.proofMode === mode && c.variant === version && c.rounds === 1 && c.reopenCard).length, 1);
}

async function prepare() {
  await absent(path.join(BASE, "matrix.json"));
  const startedAtMs = Date.now(), q6 = await read(Q6_MATRIX), q8 = await read(Q8_MATRIX);
  const currentRuntime = await runtime(q8.runtime); assert.deepEqual(currentRuntime, q8.runtime);
  const versions = await Promise.all(["q8", "candidate"].map((v) => read(path.join(BASE, `${v}-freeze.json`))));
  assert.equal(versions[0].helperSha256, versions[1].helperSha256);
  const auxiliary = ordinaryAux(`codex-q9-${randomUUID()}`);
  await mkdir(auxiliary);
  const cells = cellsFor(q6, q8, auxiliary), inputHashes = {};
  const pricing = { ...q8.pricing, file: path.join(BASE, "captured-pricing.json") };
  await copyFile(q8.pricing.file, pricing.file);
  for (const cell of cells) {
    await mkdir(cell.prepared.stateDirectory, { recursive: true });
    await mkdir(path.dirname(cell.prepared.importStoreFile));
    for (const key of ["importStoreFile", "pricingFile", "automaticPricingFile"]) {
      try { await copyFile(cell.sourcePrepared[key], cell.prepared[key]); }
      catch (error) {
        if (error.code !== "ENOENT" || key === "automaticPricingFile") throw error;
        await writeFile(cell.prepared[key], key === "importStoreFile" ? "[]\n" : "{}\n", { flag: "wx" });
      }
    }
    for (const [kind, prior] of Object.entries(cell.prior)) {
      const info = await stat(prior.path);
      assert.equal(info.nlink, 1);
      prior.sha256 = await hashFile(prior.file);
      assert.equal(await hashFile(prior.path), prior.sha256, "Canonical source not restored");
      Object.assign(prior, { atimeMs: info.atimeMs, mtimeMs: info.mtimeMs, size: info.size });
      assert.equal(prior.path, cell.prepared.selected[kind].targetPath);
    }
    for (const file of [cell.prepared.seedDatabaseFile, ...Object.values(cell.prior).map((p) => p.file),
      cell.prepared.importStoreFile, cell.prepared.pricingFile, cell.prepared.automaticPricingFile])
      inputHashes[file] = await hashFile(file);
    await save(path.join(cell.directory, "prepared.json"), cell.prepared, true);
  }
  inputHashes[pricing.file] = await hashFile(pricing.file);
  const matrix = { generation: "q9", planned: PLANNED, cells, versions, auxiliary, pricing, inputHashes,
    appendTimeMs: Date.now() - 60000, heaps: { gateway: 512, executor: 224, semi: 4 },
    runtime: currentRuntime, hookModule: path.join(ROOT, HERE, "q9-hook.mjs"),
    setup: { startedAtMs, endedAtMs: Date.now(), seedImports: 0 },
    sources: { q6: Q6_MATRIX, q8: Q8_MATRIX },
    gates: { newSessionMaximumMs: 1500, fileCountMaximumRatio: 1.3, sameModeMaximumRegression: .1, serviceTreeMaximumMiB: 512 } };
  assertMatrix(matrix);
  await save(path.join(BASE, "matrix.json"), matrix, true);
  console.log(JSON.stringify({ prepared: true, planned: PLANNED, auxiliary }));
}

export function fixtureSource(relative, source) {
  const replace = (from, to) => {
    assert.equal(source.split(from).length, 2, `Q9 harness anchor changed: ${relative}: ${from}`);
    source = source.replace(from, to);
  };
  if (relative === `${HERE}/q6-performance-run.mjs`) {
    replace("const appendTimeMs = cell.reopenCard ? Date.now() - 60000 : matrix.appendTimeMs;", "const appendTimeMs = matrix.appendTimeMs;");
    replace("release = await lockCanonical(prepared);", "release = await lockCanonical(prepared); globalThis.__q9Acquired = true; globalThis.__q9Release = release; await globalThis.__q9Before(cell);");
    replace("await release();", "// Q9 retains the lock through owned-path cleanup and inventory verification.");
    replace('path.join(here, "b2-attribution-resource.ps1")', JSON.stringify(path.join(BASE, "versions/q8", HERE, "b2-attribution-resource.ps1")));
    replace("server = await launch(); result.server = server.ready;", "await globalThis.__q9Setup(cell,result,checkpoint); server = await launch(); result.server = server.ready;");
    replace("if (cell.reopenCard) {", "await globalThis.__q9Initial(browser,cell,result,checkpoint); if (cell.reopenCard) {");
    replace("let expected = browser.all.total;", "await globalThis.__q9NewSessions(browser,cell,result,checkpoint); let expected = browser.all.total;");
  }
  if (relative === `${HERE}/b2-page-diagnostic.mjs`) replace(
    "resets_at: Math.floor((Date.now() + 5 * 60 * 60 * 1000) / 1000)",
    "resets_at: Math.floor((state.nextTimestampMs - 1000 + 5 * 60 * 60 * 1000) / 1000)");
  if (relative === `${HERE}/q5-summary-hook.mjs`) replace(
    "const response=await pending,body=await response.json();\n    Object.assign(row,", "const response=await pending,body=await response.json();row.body=body;\n    Object.assign(row,");
  return source;
}

async function run(id) {
  const matrix = await read(path.join(BASE, "matrix.json")); assertMatrix(matrix);
  const cell = matrix.cells.find((c) => c.id === id); assert.ok(cell, "Unknown cell id");
  await absent(path.join(cell.directory, "attempt.json")); await absent(path.join(cell.directory, "result.json"));
  for (const v of matrix.versions) for (const [file, hash] of Object.entries(await read(v.hashesFile)))
    assert.equal(await hashFile(path.join(v.directory, file)), hash, `Frozen file changed: ${file}`);
  for (const [file, hash] of Object.entries(matrix.inputHashes)) assert.equal(await hashFile(file), hash, `Input changed: ${file}`);
  for (const p of Object.values(cell.prior)) assert.equal(await hashFile(p.path), p.sha256, "Canonical source not restored");
  assert.deepEqual(await runtime(matrix.runtime), matrix.runtime, "Current Node/pwsh/browser changed");
  const attempt = { id, status: "started", startedAt: new Date().toISOString() };
  await save(path.join(cell.directory, "attempt.json"), attempt, true);
  const frozen = matrix.versions.find((v) => v.variant === "q8"), hashes = await read(frozen.hashesFile);
  const loader = registerHooks({ load(url, context, next) {
    if (!url.startsWith("file:")) return next(url, context);
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (Object.hasOwn(hashes, relative) && /\.(mjs|js)$/.test(relative)) {
      const bytes = readFileSync(path.join(frozen.directory, relative)); assert.equal(sha(bytes), hashes[relative]);
      return { source: fixtureSource(relative, bytes.toString()), format: "module", shortCircuit: true };
    }
    return next(url, context);
  } });
  let probes;
  try {
    process.env.ARCH_PLAYWRIGHT_MODULE = matrix.runtime.playwright.file;
    process.env.ARCH_CHROMIUM = matrix.runtime.chromium.file;
    probes = await import("./q9-sessions.mjs"); await probes.install(cell, matrix);
    const result = await (await import("./q6-performance-run.mjs")).runCell(cell, matrix);
    attempt.status = result.passed ? "passed" : "failed";
  } catch (e) { attempt.status = "failed"; attempt.error = { message: e.message, stack: e.stack }; process.exitCode = 1; }
  finally {
    attempt.restoration = [];
    if (globalThis.__q9Acquired) {
      try { attempt.ownedCleanup = await probes?.cleanup(); }
      catch (e) { attempt.cleanupError = e.message; attempt.status = "failed"; process.exitCode = 1; }
      for (const p of Object.values(cell.prior)) {
        try {
          assert.equal((await stat(p.path)).nlink, 1); await copyFile(p.file, p.path);
          assert.equal(await hashFile(p.path), p.sha256); await utimes(p.path, p.atimeMs / 1000, p.mtimeMs / 1000);
          attempt.restoration.push({ path: p.path, restored: true, sha256: p.sha256 });
        } catch (e) { attempt.restoration.push({ path: p.path, restored: false, error: e.message }); attempt.status = "failed"; process.exitCode = 1; }
      }
      try { attempt.sourceInventoryRestoration = await probes?.verifyRestored(); }
      catch (e) { attempt.inventoryError = e.message; attempt.status = "failed"; process.exitCode = 1; }
      try { await globalThis.__q9Release?.(); }
      catch (e) { attempt.releaseError = e.message; attempt.status = "failed"; process.exitCode = 1; }
    }
    loader.deregister(); attempt.finishedAt = new Date().toISOString();
    await save(path.join(cell.directory, "attempt.json"), attempt);
  }
}

async function selfcheck() {
  const q6 = await read(Q6_MATRIX), q8 = await read(Q8_MATRIX);
  assertMatrix({ cells: cellsFor(q6, q8, ordinaryAux("codex-q9-selfcheck")), planned: PLANNED });
  assert.throws(() => assertMatrix({ cells: [], planned: PLANNED }));
  assert.throws(() => ordinaryAux("../escape"));
  for (const name of ["q6-performance-run.mjs", "b2-page-diagnostic.mjs", "q5-summary-hook.mjs"]) {
    const relative = `${HERE}/${name}`, source = git("show", `${Q8_COMMIT}:${relative}`).toString();
    const patched = fixtureSource(relative, source); assert.notEqual(patched, source);
    assert.throws(() => fixtureSource(relative, patched));
  }
  await (await import("./q9-sessions.mjs")).selfcheck();
  const { sqlCounts } = await import("./q9-hook.mjs");
  assert.deepEqual(sqlCounts("DELETE FROM usage_source_catalog"), { catalogDeleteStatements: 1, catalogClearStatements: 1, wholeInventoryReads: 0 });
  assert.equal(sqlCounts("DELETE FROM usage_source_catalog WHERE path=?").catalogClearStatements, 0);
  assert.equal(sqlCounts("SELECT * FROM source_files").wholeInventoryReads, 1);
  assert.equal(sqlCounts("SELECT * FROM source_files WHERE path=?").wholeInventoryReads, 0);
  assert.equal(sqlCounts("SELECT * FROM usage_source_catalog WHERE role='file'").wholeInventoryReads, 1);
  console.log(JSON.stringify({ selfcheck: "passed", planned: PLANNED, servicesStarted: 0, timedObservations: 0 }));
}

async function cli() {
  const [command, arg] = process.argv.slice(2);
  if (command === "freeze") await freeze(arg);
  else if (command === "prepare") await prepare();
  else if (command === "run") await run(arg);
  else if (command === "selfcheck") await selfcheck();
  else throw new Error("freeze q8|candidate | prepare | run CELL_ID | selfcheck");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((error) => { console.error(error); process.exitCode = 1; });
