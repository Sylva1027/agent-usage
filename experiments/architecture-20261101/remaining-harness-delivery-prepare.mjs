import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, statfs, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BASE = path.resolve(process.env.REMAINING_DELIVERY_ROOT || path.join(ROOT, "output/remaining-harness-delivery-20261105"));
assert.ok(inside(path.join(ROOT, "output"), BASE), "delivery evidence must stay in workspace output");
export const KINDS = ["claude", "workbuddy", "zcode", "opencode"];
export const read = async (file) => JSON.parse(await readFile(file, "utf8"));
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", flush: true });
}
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(bytes);
  return hash.digest("hex");
}
export function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function usageOptions(matrix, shutdownToken) {
  const state = path.join(BASE, "working-state");
  return { homeDir: matrix.home, env: {}, importDirs: matrix.sources.map((source) => source.path),
    databaseFile: path.join(state, "usage-index.sqlite"), importStoreFile: path.join(state, "imports.json"),
    pricingFile: path.join(state, "pricing.json"), automaticPricingFile: path.join(state, "pricing-auto.json"),
    automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false, shutdownToken };
}
export async function verifyRuntime(version) {
  for (const [relative, expected] of Object.entries(version.hashes)) {
    assert.equal(await hashFile(path.join(version.directory, relative)), expected, `runtime drift: ${relative}`);
  }
}

export async function prepare() {
  await assert.rejects(stat(path.join(BASE, "matrix.json")), (error) => error.code === "ENOENT");
  const disk = await statfs(BASE, { bigint: true });
  assert.ok(disk.bavail * disk.bsize > 10n * 1024n ** 3n, "need 10 GiB for private corpus and indexes");
  const prior = path.join(ROOT, "output/remaining-harnesses-20261105");
  const baselineManifest = await read(path.join(prior, "baseline-hashes.json"));
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).toString().trim();
  execFileSync("git", ["diff", "--exit-code", "27f16c2", "--", "src", "public", "native", "package.json", "package-lock.json"], { cwd: ROOT });
  const versions = {};
  const nativeFiles = execFileSync("git", ["ls-files", "--", "native/windows-source-proof"], { cwd: ROOT, windowsHide: true })
    .toString().trim().split(/\r?\n/).filter(Boolean);
  assert.equal(execFileSync("git", ["diff", "3f0c7b2", "HEAD", "--", "native"], { cwd: ROOT }).length, 0);
  for (const variant of ["baseline", "candidate"]) {
    const directory = path.join(BASE, "versions", variant), hashes = {};
    const entries = variant === "baseline" ? baselineManifest.map((entry) => entry.path) : [];
    if (variant === "candidate") for (const folder of ["src", "public"]) {
      for (const entry of await readdir(path.join(ROOT, folder), { recursive: true })) {
        const relative = path.join(folder, entry);
        if ((await stat(path.join(ROOT, relative))).isFile()) entries.push(relative);
      }
    }
    for (const relative of [...entries, ...nativeFiles, "package.json", "package-lock.json"]) {
      const original = variant === "baseline" && entries.includes(relative)
        ? path.join(prior, "baseline", relative) : path.join(ROOT, relative);
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await copyFile(original, path.join(directory, relative));
      hashes[relative] = await hashFile(path.join(directory, relative));
      if (variant === "baseline" && entries.includes(relative)) {
        assert.equal(hashes[relative], baselineManifest.find((entry) => entry.path === relative).sha256);
      }
    }
    for (const name of ["windows-source-proof.exe", "windows-source-proof.build.json"]) {
      const relative = path.join("native/windows-source-proof/bin", name);
      const original = path.join(ROOT, "output/delivery-20261105/runtime", relative);
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await copyFile(original, path.join(directory, relative)); hashes[relative] = await hashFile(original);
    }
    versions[variant] = { directory, hashes, commit: variant === "baseline" ? "3f0c7b2" : "27f16c2", workspaceCommit: current };
  }
  const pointer = await read(path.join(ROOT, "output/architecture-20261102/full-startup/capture-pointer.json"));
  const capture = await read(pointer.file), captureRoot = path.dirname(pointer.file);
  const home = path.join(BASE, "home"), roots = new Map(capture.logicalRoots.map((source) => [source.id,
    { ...source, originalPath: source.path, path: path.join(home, "sources", source.id) }]));
  const files = [];
  for (const file of capture.files) {
    const source = roots.get(file.sourceId), relative = path.relative(source.originalPath, file.logicalPath);
    const target = path.join(source.path, relative), original = path.resolve(captureRoot, file.capturedPath);
    assert.ok(inside(source.path, target)); assert.ok(inside(captureRoot, original));
    assert.equal(await hashFile(original), file.sha256, "frozen original bytes changed");
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(original, target);
    const info = file.capturedStat;
    await utimes(target, info.atimeMs / 1000, info.mtimeMs / 1000);
    assert.equal(await hashFile(target), file.sha256);
    files.push({ kind: file.sourceKind, role: file.role, filePath: target, original, sha256: file.sha256,
      bytes: info.size, mtimeMs: (await stat(target)).mtimeMs, sourceId: source.id, storageType: file.storageType });
  }
  const sources = await (await import(pathToFileURL(path.join(versions.baseline.directory, "src/usage-core.js"))))
    .discoverUsageSources({ homeDir: home, env: {}, importDirs: [...roots.values()].map((source) => source.path) });
  assert.equal(sources.length, roots.size);
  const selected = {};
  for (const kind of KINDS) {
    const file = files.filter((entry) => entry.kind === kind && entry.role === "usage-file").sort((a, b) => b.bytes - a.bytes)[0];
    assert.ok(file, `missing ${kind}`);
    selected[kind] = { ...file, source: sources.find((source) => inside(source.path, file.filePath)) };
    assert.ok(selected[kind].source);
  }
  const q10 = await read(path.join(ROOT, "output/architecture-20261105/q10/matrix.json"));
  const state = path.join(BASE, "working-state"); await mkdir(state);
  for (const name of ["pricing.json", "pricing-auto.json"]) {
    try { await copyFile(path.join(q10.pricing.inputDirectory, name), path.join(state, name)); }
    catch (error) { if (error.code !== "ENOENT" || name !== "pricing.json") throw error; }
  }
  const matrix = { versions, sources, selected, files, home, runtime: q10.runtime,
    capture: { manifest: pointer.file, summary: pointer.summary, copiedBytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    planned: { groups: 8, appends: 16, revisions: 8, reopens: 8 }, createdAt: new Date().toISOString() };
  await save(path.join(BASE, "matrix.json"), matrix);
  console.log(JSON.stringify({ prepared: true, files: files.length, bytes: matrix.capture.copiedBytes,
    sources: sources.map((source) => source.kind), selected: Object.fromEntries(KINDS.map((kind) => [kind, selected[kind].bytes])) }));
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await prepare();
