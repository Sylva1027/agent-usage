import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BASE = path.join(ROOT, "output/architecture-20261105/q8");
export const Q7_COMMIT = "4807ebe1dbf73ce662dc31288e2fdeb1d1cd4701";
const HERE = "experiments/architecture-20261101";
const ORIGINAL = path.join(ROOT, "output/architecture-20261105/q7/reopen-b/matrix.json");
const HELPER = "native/windows-source-proof/bin/windows-source-proof.exe";
const TOOLS = ["q8-refresh-run.mjs", "q8-refresh-analyze.mjs", "q6-performance-run.mjs", "q6-performance-prepare.mjs",
  "q7-reopen-hook.mjs", "q6-performance-hook.mjs", "q5-fixture.mjs", "q5-summary-hook.mjs",
  "b2-page-diagnostic.mjs", "b2-attribution-resource.ps1", "q3-benchmark-support.mjs",
  "q6-performance-analyze.mjs", "q7-reopen-analyze.mjs"].map((name) => `${HERE}/${name}`);
export const PLANNED = { groups: 4, appends: 16, reopens: 4, emptyImports: 0 };
export const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const saveNew = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
const git = (...args) => execFileSync("git", args, { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function absent(file) {
  await assert.rejects(stat(file), (error) => error.code === "ENOENT", `Already exists: ${file}; retain the original attempt`);
}
async function hashesAt(root, files) {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hashFile(path.join(root, file))])));
}

async function runtime() {
  const pwsh = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command",
    "@{path=(Get-Process -Id $PID).Path;version=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true }));
  const playwright = process.env.ARCH_PLAYWRIGHT_MODULE ||
    "C:/Users/Silver/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs";
  const chromium = process.env.ARCH_CHROMIUM ||
    "C:/Users/Silver/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
  const packageFile = path.join(path.dirname(playwright), "package.json");
  return { node: { file: process.execPath, sha256: await hashFile(process.execPath), versions: process.versions },
    pwsh: { ...pwsh, sha256: await hashFile(pwsh.path) },
    playwright: { file: playwright, sha256: await hashFile(playwright), packageSha256: await hashFile(packageFile),
      version: (await read(packageFile)).version }, chromium: { file: chromium, sha256: await hashFile(chromium) },
    platform: process.platform, arch: process.arch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function freeze(variant) {
  assert.ok(["q7", "candidate"].includes(variant), "freeze q7 | freeze candidate");
  const directory = path.join(BASE, "versions", variant);
  await absent(directory);
  const original = await read(ORIGINAL);
  const old = original.versions.find((row) => row.variant === "candidate");
  const oldHashes = await read(old.hashesFile);
  const files = git("ls-tree", "-r", "--name-only", Q7_COMMIT, "--", "src", "public", "native", "package.json", "package-lock.json")
    .toString().trim().split(/\r?\n/);
  if (variant === "candidate") {
    const current = git("ls-files", "--", "src", "public", "native", "package.json", "package-lock.json").toString().trim().split(/\r?\n/);
    assert.deepEqual(current, files, "Q8 card does not add/remove runtime files; review the freeze list if scope changed");
  }
  await mkdir(directory, { recursive: true });
  const hashes = {};
  for (const relative of files) {
    const bytes = variant === "q7" ? git("show", `${Q7_COMMIT}:${relative}`) : await readFile(path.join(ROOT, relative));
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), bytes, { flag: "wx" });
    hashes[relative] = sha(bytes);
  }
  assert.equal(await hashFile(old.nativeBinary), oldHashes[HELPER], "Q7 helper changed");
  await mkdir(path.dirname(path.join(directory, HELPER)), { recursive: true });
  await copyFile(old.nativeBinary, path.join(directory, HELPER));
  hashes[HELPER] = oldHashes[HELPER];
  const receipt = { variant, directory, hashesFile: path.join(BASE, `${variant}-hashes.json`),
    nativeBinary: path.join(directory, HELPER), commit: variant === "q7" ? Q7_COMMIT : git("rev-parse", "HEAD").toString().trim(),
    source: variant === "q7" ? "git blobs" : "working tree", createdAt: new Date().toISOString(),
    toolHashes: await hashesAt(ROOT, TOOLS), runtime: await runtime(), helperSha256: hashes[HELPER] };
  await saveNew(receipt.hashesFile, hashes);
  await saveNew(path.join(BASE, `${variant}-freeze.json`), receipt);
  console.log(JSON.stringify({ frozen: variant, directory, commit: receipt.commit, files: Object.keys(hashes).length }));
}

export function nativeAux(localAppData) {
  assert.ok(localAppData, "LOCALAPPDATA must identify the ordinary C: user directory");
  const root = path.win32.join(localAppData, "Temp", "codex-q8-refresh-20261105");
  assert.match(root, /^C:\\/i, "Native auxiliary inputs must stay on ordinary C: storage");
  return root;
}

export function cellsFor(original, auxiliary) {
  const cells = [];
  for (const proofMode of ["native", "sha"]) {
    const template = original.cells.find((row) => row.phase === "formal" && row.proofMode === proofMode && row.variant === "candidate");
    assert.ok(template, `Missing Q7 ${proofMode} seed`);
    for (const variant of ["q7", "candidate"]) {
      const directory = path.join(BASE, "formal", proofMode, variant), stateDirectory = path.join(directory, "state");
      const config = proofMode === "native" ? path.join(auxiliary, variant) : stateDirectory;
      cells.push({ id: `10x-${proofMode}`, proofMode, phase: "formal", variant, directory, rounds: 2,
        diagnostic: false, reopenCard: true, fixtureVariant: "candidate", prior: {},
        prepared: { ...template.prepared, stateDirectory, databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
          importStoreFile: path.join(config, "imports.json"), pricingFile: path.join(config, "pricing.json"),
          automaticPricingFile: path.join(config, "pricing-auto.json") } });
    }
  }
  return cells;
}

export function assertMatrix(matrix) {
  assert.equal(matrix.generation, "q8");
  assert.deepEqual(matrix.planned, PLANNED);
  assert.equal(matrix.cells.length, 4);
  assert.deepEqual(matrix.cells.map((cell) => `${cell.proofMode}/${cell.variant}`), ["native/q7", "native/candidate", "sha/q7", "sha/candidate"]);
  for (const cell of matrix.cells) {
    assert.equal(cell.rounds, 2); assert.equal(cell.reopenCard, true); assert.equal(cell.diagnostic, false);
    assert.equal(cell.fixtureVariant, "candidate");
  }
  for (const mode of ["native", "sha"]) {
    const [a, b] = matrix.cells.filter((cell) => cell.proofMode === mode);
    for (const key of ["home", "selected", "seedDatabaseFile", "canonicalDirectory"]) assert.deepEqual(a.prepared[key], b.prepared[key]);
    assert.deepEqual(a.prior, b.prior);
  }
}

async function prepare() {
  await absent(path.join(BASE, "matrix.json"));
  const versions = await Promise.all(["q7", "candidate"].map((variant) => read(path.join(BASE, `${variant}-freeze.json`))));
  assert.deepEqual(versions[0].runtime, versions[1].runtime, "Use identical runtimes for both freezes");
  assert.deepEqual(versions[0].toolHashes, versions[1].toolHashes, "Freeze both versions after the tooling is final");
  for (const version of versions) await verifyVersion(version);
  const original = await read(ORIGINAL), auxiliary = nativeAux(path.win32.join(os.homedir(), "AppData", "Local"));
  await absent(auxiliary);
  const cells = cellsFor(original, auxiliary);
  const pricing = { ...original.pricing, file: path.join(BASE, "captured-pricing.json") };
  await copyFile(original.pricing.file, pricing.file);
  const inputHashes = { [ORIGINAL]: await hashFile(ORIGINAL), [pricing.file]: await hashFile(pricing.file) };
  for (const mode of ["native", "sha"]) {
    const pair = cells.filter((cell) => cell.proofMode === mode), prepared = pair[0].prepared;
    // This is the same closed seed for both versions; runCell checks its raw-fact digest before opening a service.
    for (const file of [prepared.seedDatabaseFile, `${prepared.seedDatabaseFile}.receipt.json`]) inputHashes[file] = await hashFile(file);
    const seed = await read(`${prepared.seedDatabaseFile}.receipt.json`);
    assert.equal(seed.closed, true); assert.equal(seed.home, prepared.home);
    assert.equal(seed.pricing.catalogSha256, pricing.catalogSha256);
    const prior = {};
    for (const [kind, selected] of Object.entries(prepared.selected)) {
      const info = await stat(selected.targetPath); assert.equal(info.nlink, 1);
      assert.equal(await hashFile(selected.sourcePath), selected.sourceSha256);
      inputHashes[selected.sourcePath] = selected.sourceSha256;
      const file = path.join(BASE, "prior-inputs", mode, kind);
      await mkdir(path.dirname(file), { recursive: true }); await copyFile(selected.targetPath, file);
      prior[kind] = { file, path: selected.targetPath, size: info.size, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs,
        sha256: await hashFile(file) };
      inputHashes[file] = prior[kind].sha256;
    }
    const template = original.cells.find((cell) => cell.phase === "formal" && cell.proofMode === mode && cell.variant === "candidate");
    for (const cell of pair) {
      cell.prior = prior;
      for (const dir of [cell.prepared.stateDirectory, path.dirname(cell.prepared.importStoreFile),
        ...["components", "resources", "resources-reopen", "temp"].map((name) => path.join(cell.directory, name))]) await mkdir(dir, { recursive: true });
      // Never create these watched inputs after source certification.
      await writeFile(cell.prepared.importStoreFile, '{"imports":[]}\n', { flag: "wx" });
      try { await copyFile(template.prepared.pricingFile, cell.prepared.pricingFile); }
      catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(cell.prepared.pricingFile, "{}\n", { flag: "wx" }); }
      await copyFile(template.prepared.automaticPricingFile, cell.prepared.automaticPricingFile);
      for (const file of [cell.prepared.importStoreFile, cell.prepared.pricingFile, cell.prepared.automaticPricingFile]) inputHashes[file] = await hashFile(file);
      await saveNew(path.join(cell.directory, "prepared.json"), cell.prepared);
    }
  }
  const matrix = { generation: "q8", base: BASE, originalMatrix: ORIGINAL, versions, pricing, cells,
    createdAt: new Date().toISOString(), appendTimeMs: Date.now() - 60_000, auxiliary,
    planned: PLANNED, inputHashes, heaps: { gateway: 512, executor: 224, semi: 4 },
    hookModule: path.join(ROOT, HERE, "q7-reopen-hook.mjs"), runtime: versions[0].runtime,
    gates: { sameModeMaximumRegression: 0.1, nativeRefreshMaximumMs: 1500, oldShaCodexMaximumMs: 4718,
      previousShaCodexMs: 4852, serviceTreeMaximumMiB: 512 } };
  assertMatrix(matrix);
  await saveNew(path.join(BASE, "matrix.json"), matrix);
  console.log(JSON.stringify({ prepared: true, base: BASE, auxiliary, planned: PLANNED }));
}

async function verifyVersion(version) {
  const hashes = await read(version.hashesFile);
  assert.deepEqual(await hashesAt(version.directory, Object.keys(hashes)), hashes, `Frozen ${version.variant} files changed`);
  assert.deepEqual(await hashesAt(ROOT, TOOLS), version.toolHashes, "Benchmark helpers changed after freezing");
}

export function fixtureSource(relative, source) {
  const replace = (from, to) => {
    assert.equal(source.split(from).length, 2, `Fixture anchor changed: ${relative}: ${from}`);
    source = source.replace(from, to);
  };
  // Only fixture data changes. Date.now/performance clocks used for measurements remain real.
  if (relative === `${HERE}/q6-performance-run.mjs`) replace(
    "const appendTimeMs = cell.reopenCard ? Date.now() - 60000 : matrix.appendTimeMs;", "const appendTimeMs = matrix.appendTimeMs;");
  if (relative === `${HERE}/q6-performance-run.mjs`) replace(
    "release = await lockCanonical(prepared);", "release = await lockCanonical(prepared); globalThis.__q8FixtureAcquired = true;");
  if (relative === `${HERE}/b2-page-diagnostic.mjs`) replace(
    "resets_at: Math.floor((Date.now() + 5 * 60 * 60 * 1000) / 1000)",
    "resets_at: Math.floor((state.nextTimestampMs - 1000 + 5 * 60 * 60 * 1000) / 1000)");
  return source;
}

async function run(mode, variant) {
  const matrix = await read(path.join(BASE, "matrix.json")); assertMatrix(matrix);
  const cell = matrix.cells.find((row) => row.proofMode === mode && row.variant === variant);
  assert.ok(cell, "run native|sha q7|candidate");
  await absent(path.join(cell.directory, "attempt.json"));
  await absent(path.join(cell.directory, "result.json"));
  assert.deepEqual(await runtime(), matrix.runtime, "Runtime changed since preparation");
  for (const version of matrix.versions) await verifyVersion(version);
  for (const [file, expected] of Object.entries(matrix.inputHashes)) assert.equal(await hashFile(file), expected, `Input changed: ${file}`);
  for (const prior of Object.values(cell.prior)) {
    assert.equal((await stat(prior.path)).nlink, 1);
    assert.equal(await hashFile(prior.path), prior.sha256, "Canonical input was not restored; do not run concurrently");
  }
  const attempt = { mode, variant, startedAt: new Date().toISOString(), planned: PLANNED, status: "started" };
  await saveNew(path.join(cell.directory, "attempt.json"), attempt);
  // Pin the shared fixture code to Q7 even when Main continues editing the checkout.
  const fixture = matrix.versions.find((row) => row.variant === "q7"), hashes = await read(fixture.hashesFile);
  const loader = registerHooks({ load(url, context, next) {
    if (!url.startsWith("file:")) return next(url, context);
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (relative.startsWith("src/") || relative.startsWith("public/")) {
      assert.ok(hashes[relative], `Unfrozen fixture dependency: ${relative}`);
      const bytes = readFileSync(path.join(fixture.directory, relative)); assert.equal(sha(bytes), hashes[relative]);
      return { source: bytes.toString(), format: "module", shortCircuit: true };
    }
    const result = next(url, context);
    if ([`${HERE}/q6-performance-run.mjs`, `${HERE}/b2-page-diagnostic.mjs`].includes(relative))
      return { ...result, source: fixtureSource(relative, result.source.toString()) };
    return result;
  } });
  try {
    process.env.ARCH_PLAYWRIGHT_MODULE = matrix.runtime.playwright.file;
    process.env.ARCH_CHROMIUM = matrix.runtime.chromium.file;
    const { runCell } = await import("./q6-performance-run.mjs");
    const result = await runCell(cell, matrix);
    attempt.status = result.passed ? "passed" : "failed";
  } catch (error) { attempt.status = "failed"; attempt.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally {
    loader.deregister();
    // Also restore atime and leave a receipt if runCell's own finally failed before restoring the second file.
    attempt.restoration = [];
    for (const prior of globalThis.__q8FixtureAcquired ? Object.values(cell.prior) : []) {
      try {
        assert.equal((await stat(prior.path)).nlink, 1);
        await copyFile(prior.file, prior.path);
        assert.equal(await hashFile(prior.path), prior.sha256);
        await utimes(prior.path, prior.atimeMs / 1000, prior.mtimeMs / 1000);
        attempt.restoration.push({ path: prior.path, restored: true, sha256: prior.sha256 });
      } catch (error) { attempt.restoration.push({ path: prior.path, restored: false, error: error.message }); process.exitCode = 1; }
    }
    attempt.finishedAt = new Date().toISOString();
    await writeFile(path.join(cell.directory, "attempt.json"), JSON.stringify(attempt, null, 2) + "\n", { flush: true });
  }
}

async function selfcheck() {
  const original = await read(ORIGINAL);
  const matrix = { generation: "q8", planned: PLANNED, cells: cellsFor(original, nativeAux("C:\\Users\\Silver\\AppData\\Local")) };
  assertMatrix(matrix);
  assert.throws(() => assertMatrix({ ...matrix, cells: matrix.cells.slice(1) }));
  assert.throws(() => nativeAux("E:\\runtime-temp"));
  for (const name of ["q6-performance-run.mjs", "b2-page-diagnostic.mjs"]) {
    const relative = `${HERE}/${name}`, source = await readFile(path.join(ROOT, relative), "utf8");
    const patched = fixtureSource(relative, source);
    assert.notEqual(patched, source); assert.throws(() => fixtureSource(relative, patched));
    if (name === "b2-page-diagnostic.mjs") {
      const body = patched.slice(patched.indexOf("function codexAppendRows("), patched.indexOf("function dshAppendFrame("));
      const append = new Function("CODEX_DELTA", "TOKEN_FIELDS", `${body};return codexAppendRows;`)(1000, ["total", "input", "cached", "output", "reasoning"]);
      const state = () => ({ cumulative: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 }, nextTimestampMs: 1793865165000 });
      const a = state(), b = state(); assert.deepEqual(append(a), append(b));
      const rows = append(a).toString().trim().split("\n").map(JSON.parse);
      assert.equal(rows[1].timestamp, new Date(1793865166000).toISOString());
      assert.equal(rows[1].payload.info.total_token_usage.total_tokens, 2000);
      assert.equal(rows[1].payload.rate_limits.primary.resets_at, 1793883166);
    }
  }
  console.log(JSON.stringify({ selfcheck: "passed", planned: PLANNED, servicesStarted: 0, writes: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b] = process.argv.slice(2);
  if (command === "freeze") await freeze(a);
  else if (command === "prepare") await prepare();
  else if (command === "run") await run(a, b);
  else if (command === "selfcheck") await selfcheck();
  else throw new Error("Commands: freeze q7 | freeze candidate | prepare | run native|sha q7|candidate | selfcheck");
}
