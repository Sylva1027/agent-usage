import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ROOT, HERE, HELPER, SHARED, hashFile, read, save, sha, runtime, fixtureSource, absent } from "./q9-benchmark.mjs";

export const BASE = path.join(ROOT, "output/architecture-20261105/q10");
const Q9 = path.join(ROOT, "output/architecture-20261105/q9");
export const PLANNED = { groups: 4, appends: 16, reopens: 8, newSessions: 4, emptyImports: 0 };
const git = (...args) => execFileSync("git", args, { cwd: ROOT, windowsHide: true });

async function prepare() {
  await absent(path.join(BASE, "matrix.json"));
  assert.equal(git("rev-parse", "--short", "HEAD").toString().trim(), "3f7b8b0");
  const previous = await read(path.join(Q9, "matrix.json"));
  const baseline = structuredClone((await read(path.join(BASE, "baseline.json"))).version);
  baseline.variant = "q9";
  const directory = path.join(BASE, "versions/candidate"); await absent(directory);
  const hashes = {};
  const files = git("ls-files", "--", "src", "public", "native", "package.json", "package-lock.json").toString().trim().split(/\r?\n/);
  for (const file of files) {
    if (file === HELPER) continue;
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await copyFile(file, path.join(directory, file)); hashes[file] = await hashFile(file);
  }
  await mkdir(path.dirname(path.join(directory, HELPER)), { recursive: true });
  await copyFile(path.join(BASE, "native-candidate-target/release/windows-source-proof.exe"), path.join(directory, HELPER));
  hashes[HELPER] = await hashFile(path.join(directory, HELPER));
  const candidate = { ...baseline, variant: "candidate", directory, nativeBinary: path.join(directory, HELPER),
    hashesFile: path.join(BASE, "candidate-hashes.json"), helperSha256: hashes[HELPER], source: "working tree plus isolated native build" };
  await save(candidate.hashesFile, hashes, true);
  const currentRuntime = await runtime(previous.runtime); assert.deepEqual(currentRuntime, previous.runtime);
  const auxiliary = path.join(os.homedir(), "AppData/Local/Temp", `codex-q10-${Date.now()}`);
  assert.match(auxiliary, /^C:[\\/]/i); await mkdir(auxiliary);
  const order = [["native", "q9"], ["native", "candidate"], ["sha", "candidate"], ["sha", "q9"]];
  const cells = order.map(([mode, variant]) => ({ ...structuredClone(previous.cells.find((c) => c.id === `refresh-${mode}-candidate`)),
    id: `${mode}-${variant}`, variant, rounds: 2 }));
  cells.push({ ...structuredClone(previous.cells.find((c) => c.id === "new-20000-candidate")), id: "new-guard", variant: "candidate" });
  const inputHashes = {};
  for (const cell of cells) {
    const priorPrepared = cell.prepared; cell.directory = path.join(BASE, "formal", cell.id);
    cell.prepared = { ...priorPrepared, stateDirectory: path.join(cell.directory, "state"),
      databaseFile: path.join(cell.directory, "state/usage-index.sqlite"),
      importStoreFile: path.join(auxiliary, cell.id, "imports.json"), pricingFile: path.join(auxiliary, cell.id, "pricing.json"),
      automaticPricingFile: path.join(auxiliary, cell.id, "pricing-auto.json") };
    await mkdir(cell.prepared.stateDirectory, { recursive: true });
    await mkdir(path.dirname(cell.prepared.importStoreFile), { recursive: true });
    for (const key of ["importStoreFile", "pricingFile", "automaticPricingFile"]) {
      await copyFile(priorPrepared[key], cell.prepared[key]); inputHashes[cell.prepared[key]] = await hashFile(cell.prepared[key]);
    }
    for (const prior of Object.values(cell.prior)) {
      assert.equal((await stat(prior.path)).nlink, 1); assert.equal(await hashFile(prior.path), prior.sha256);
    }
  }
  const matrix = { generation: "q10", versions: [baseline, candidate], cells, planned: PLANNED, inputHashes,
    pricing: previous.pricing, runtime: currentRuntime, appendTimeMs: Date.now() - 60000,
    hookModule: path.join(ROOT, HERE, "q10-refresh-hook.mjs"), auxiliary };
  await save(path.join(BASE, "matrix.json"), matrix, true);
  console.log(JSON.stringify({ prepared: true, order: cells.map((c) => c.id), planned: PLANNED }));
}

export function transform(relative, source) {
  source = fixtureSource(relative, source);
  if (relative === `${HERE}/q6-performance-run.mjs`) {
    const needle = 'if (!cell.fileCount && !cell.reopenCard) {\n      const reopen = Date.now();';
    assert.equal(source.split(needle).length, 2);
    source = source.replace(needle, `if (cell.reopenCard) {
      result.appendDelivery = result.delivery;
      const reopenedAt = Date.now(); server = await launch('-reopen-final'); sampler = await sampling('reopen-final');
      browser = await openPage(server.ready.url, directory, [observeQ5Delivery]);
      assert.equal(browser.all.total, expected); assert.deepEqual(browser.errors, []);
      result.reopens = [result.reopen, {startedAtMs:reopenedAt,endedAtMs:Date.now(),all:browser.all}]; await checkpoint();
    }
    ${needle}`);
  }
  if (relative === `${HERE}/q5-summary-hook.mjs`) {
    const needle = "  window.__q5Delivery={rows,get dropped(){return dropped;}};";
    assert.equal(source.split(needle).length, 2);
    source = source.replace(needle, `${needle}
  const clones=new WeakSet(),originalClone=Response.prototype.clone,originalJson=Response.prototype.json;
  Response.prototype.clone=function(...args){const clone=originalClone.apply(this,args);clones.add(clone);return clone;};
  Response.prototype.json=async function(...args){
    const started=performance.timeOrigin+performance.now();const body=await originalJson.apply(this,args);
    if(this.url&&new URL(this.url,location.href).pathname==='/api/usage')emit('json-consumed',
      {started,cloned:clones.has(this),total:body.summary?.totals?.total,bytes:this.headers.get('content-length')});return body;
  };`);
  }
  return source;
}

async function run(id) {
  const matrix = await read(path.join(BASE, "matrix.json")), cell = matrix.cells.find((c) => c.id === id);
  assert.ok(cell); await absent(path.join(cell.directory, "attempt.json"));
  for (const version of matrix.versions) for (const [file, hash] of Object.entries(await read(version.hashesFile)))
    assert.equal(await hashFile(path.join(version.directory, file)), hash, file);
  for (const [file, hash] of Object.entries(matrix.inputHashes)) assert.equal(await hashFile(file), hash);
  assert.deepEqual(await runtime(matrix.runtime), matrix.runtime);
  const harness = path.join(Q9, "versions/q8"), hashes = await read(path.join(Q9, "q8-hashes.json"));
  const loader = registerHooks({ load(url, context, next) {
    if (!url.startsWith("file:")) return next(url, context);
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (!SHARED.includes(relative)) return next(url, context);
    const bytes = readFileSync(path.join(harness, relative)); assert.equal(sha(bytes), hashes[relative]);
    return { source: transform(relative, bytes.toString()), format: "module", shortCircuit: true };
  } });
  const attempt = { id, startedAt: new Date().toISOString(), status: "started" };
  await save(path.join(cell.directory, "attempt.json"), attempt, true);
  let probes;
  try {
    process.env.ARCH_PLAYWRIGHT_MODULE = matrix.runtime.playwright.file;
    process.env.ARCH_CHROMIUM = matrix.runtime.chromium.file;
    probes = await import("./q9-sessions.mjs"); await probes.install(cell, matrix);
    const result = await (await import("./q6-performance-run.mjs")).runCell(cell, matrix);
    attempt.status = result.passed ? "passed" : "failed";
  } catch (error) { attempt.status = "failed"; attempt.error = error.stack; process.exitCode = 1; }
  finally {
    if (globalThis.__q9Acquired) {
      try {
        attempt.ownedCleanup = await probes.cleanup(); attempt.restoration = [];
        for (const prior of Object.values(cell.prior)) {
          assert.equal((await stat(prior.path)).nlink, 1); await copyFile(prior.file, prior.path);
          assert.equal(await hashFile(prior.path), prior.sha256);
          await utimes(prior.path, prior.atimeMs / 1000, prior.mtimeMs / 1000); attempt.restoration.push({ restored: true, sha256: prior.sha256 });
        }
        attempt.inventory = await probes.verifyRestored();
      } catch (error) { attempt.status = "failed"; attempt.cleanupError = error.stack; process.exitCode = 1; }
      finally { await globalThis.__q9Release?.(); }
    }
    loader.deregister(); attempt.finishedAt = new Date().toISOString();
    await save(path.join(cell.directory, "attempt.json"), attempt);
  }
}

async function selfcheck() {
  const hashes = await read(path.join(Q9, "q8-hashes.json"));
  for (const file of SHARED) {
    const bytes = await readFile(path.join(Q9, "versions/q8", file)); assert.equal(sha(bytes), hashes[file]);
    const target = path.join(BASE, "syntax", path.basename(file)); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, transform(file, bytes.toString()));
    if (/\.[cm]?js$/.test(file)) execFileSync(process.execPath, ["--check", target], { windowsHide: true });
  }
  assert.deepEqual(PLANNED, { groups: 4, appends: 16, reopens: 8, newSessions: 4, emptyImports: 0 });
  console.log(JSON.stringify({ selfcheck: "passed", servicesStarted: 0 }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "prepare") await prepare();
  else if (process.argv[2] === "run") await run(process.argv[3]);
  else { assert.equal(process.argv[2], "selfcheck"); await selfcheck(); }
}
