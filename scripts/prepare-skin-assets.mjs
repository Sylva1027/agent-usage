/**
 * Skin asset preparation and verification (implementation plan 5 and 3.4).
 *
 *   node scripts/prepare-skin-assets.mjs prepare        # write derived artifacts (authoring checkout)
 *   node scripts/prepare-skin-assets.mjs check          # verify what ships, read-only
 *   node scripts/prepare-skin-assets.mjs check-sources  # check + bind the 40 authoring PNGs
 *
 * Scope and honest limits:
 *   - Node has no built-in image encoder, and these commands may only use built-in
 *     fs/path without adding production dependencies. So this script never
 *     re-encodes the 40 public WebP copies. Those come from the one-off
 *     development generator documented in plan 3.4.
 *   - `prepare` derives everything that follows from the registry: the asset
 *     manifest (with expected hashes) and the synchronous bootstrap script.
 *   - `check` verifies only what a release archive contains: the registry
 *     contract, the 40 committed WebP copies against the recorded hashes, the
 *     manifest and the bootstrap. `.gitattributes` export-ignores
 *     `lineart assets/`, so this command must pass in a tree without the
 *     authoring PNGs.
 *   - `check-sources` runs the same checks and additionally binds every public
 *     copy to its source PNG. A changed source fails here instead of being
 *     ignored. When `lineart assets/` is absent — a release archive — it prints
 *     SKIP rather than PASS, because there is nothing to compare against.
 *
 * The generated bootstrap is emitted already formatted, so `format:check` stays
 * meaningful; the checks compare against that same canonical text.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSkinBootstrapSource } from "./skin-palette/bootstrap-source.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GENERATOR_REFERENCE = "docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py";
const SOURCE_ROOT_NAME = "lineart assets";

const skins = await import(pathToFileURL(path.join(defaultRoot, "public", "skins.js")).href);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function readMaybe(file) {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Atomic write so an interrupted run cannot leave a half-written artifact. */
async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

/**
 * The files one tree owns. The registry itself is code and always comes from
 * this checkout, so a sandbox only has to supply data: the manifest, the
 * bootstrap, the public copies and (for source binding) the PNGs.
 */
function treeAt(root) {
  const publicDir = path.join(root, "public");
  return {
    root,
    publicDir,
    manifestFile: path.join(publicDir, "skin-assets.json"),
    bootstrapFile: path.join(publicDir, "skin-bootstrap.js"),
    sourceRoot: path.join(root, SOURCE_ROOT_NAME),
  };
}

function expectedManifest() {
  const assets = {};
  for (const entry of skins.enumerateSourceAssets()) {
    assets[entry.publicUrl] = {
      skinId: entry.skinId,
      mode: entry.mode,
      view: entry.view,
      sourcePath: entry.sourcePath,
      publicPath: `public/assets/skins/${entry.mode}/${entry.expectedName}`,
      expectedName: entry.expectedName,
    };
  }
  return assets;
}

/**
 * Run the repository formatter over a generated file so its committed form is
 * canonical. The formatter is a devDependency used only by this command, never
 * by export or serve, so production stays dependency-free.
 */
async function formatGenerated(tree, file) {
  const biome = path.join(tree.root, "node_modules", "@biomejs", "biome", "bin", "biome");
  if (!existsSync(biome)) return false;
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [biome, "format", "--write", file], { cwd: tree.root, encoding: "utf8" });
  return result.status === 0;
}

/**
 * The canonical text of the generated bootstrap: emit it, format it, read back
 * what the formatter produced. Cached per tree so prepare and check agree.
 */
const canonicalBootstrapCache = new Map();
async function canonicalBootstrapText(tree) {
  if (canonicalBootstrapCache.has(tree.root)) return canonicalBootstrapCache.get(tree.root);
  // M1.2: the registry/payload construction and IIFE template live in the pure
  // emitter (scripts/skin-palette/bootstrap-source.mjs) so dev previews can
  // reuse them in memory with palette overrides. This command stays the only
  // writer of the production file and keeps the format-probe dance here.
  const raw = buildSkinBootstrapSource();
  const probe = `${tree.bootstrapFile}.probe-${process.pid}`;
  await writeAtomic(probe, raw);
  const formatted =
    (await formatGenerated(tree, probe)) === false ? raw : (await readMaybe(probe)).toString("utf8");
  const { rm } = await import("node:fs/promises");
  await rm(probe, { force: true });
  canonicalBootstrapCache.set(tree.root, formatted);
  return formatted;
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

async function prepare(tree) {
  const expected = expectedManifest();
  const existing = JSON.parse((await readMaybe(tree.manifestFile))?.toString("utf8") ?? "null");
  const assets = {};
  const missing = [];

  for (const [url, entry] of Object.entries(expected)) {
    const sourceBytes = await readMaybe(path.join(tree.root, entry.sourcePath));
    const publicBytes = await readMaybe(path.join(tree.root, entry.publicPath));
    if (!sourceBytes) missing.push(entry.sourcePath);
    if (!publicBytes) missing.push(entry.publicPath);
    assets[url] = {
      ...entry,
      sourceBytes: sourceBytes ? sourceBytes.length : null,
      sourceSha256: sourceBytes ? sha256(sourceBytes) : null,
      publicBytes: publicBytes ? publicBytes.length : null,
      publicSha256: publicBytes ? sha256(publicBytes) : null,
      // Carried over from the generator, which is the only place that can decode
      // the encoding step and prove losslessness.
      alphaMaxDelta: existing?.assets?.[url]?.alphaMaxDelta ?? null,
      rgbMaxDeltaVisible: existing?.assets?.[url]?.rgbMaxDeltaVisible ?? null,
      transparentRgbReduced: existing?.assets?.[url]?.transparentRgbReduced ?? null,
    };
  }

  const manifest = {
    generatedBy: "scripts/prepare-skin-assets.mjs",
    encodingGeneratedBy: GENERATOR_REFERENCE,
    transform: "PNG(RGBA) -> WebP lossless, geometry and ink polarity preserved, no resize/recolour/invert",
    note: "This command does not re-encode images; see implementation plan 3.4.",
    assets,
  };
  await writeAtomic(tree.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const bootstrap = await canonicalBootstrapText(tree);
  const currentBootstrap = await readMaybe(tree.bootstrapFile);
  const bootstrapChanged = currentBootstrap?.toString("utf8") !== bootstrap;
  if (bootstrapChanged) await writeAtomic(tree.bootstrapFile, bootstrap);

  console.log(`prepare: ${Object.keys(assets).length} assets recorded`);
  console.log(`prepare: wrote ${path.relative(tree.root, tree.manifestFile)}`);
  console.log(`prepare: ${bootstrapChanged ? "wrote" : "unchanged"} ${path.relative(tree.root, tree.bootstrapFile)}`);
  if (missing.length) {
    console.log(`prepare: ${missing.length} file(s) missing:`);
    for (const file of missing) console.log(`  ${file}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** Registry contract: 40 assets, one URL each, extension and file name agree. */
function checkRegistry(sources) {
  const problems = [];
  const registryUrls = new Set();
  if (sources.length !== 40) problems.push(`registry enumerates ${sources.length} source assets, expected 40`);
  for (const entry of sources) {
    registryUrls.add(entry.publicUrl);
    if (!entry.publicUrl.startsWith(`/assets/skins/${entry.mode}/`)) {
      problems.push(`${entry.skinId}/${entry.mode}/${entry.view}: unexpected public path ${entry.publicUrl}`);
    }
    if (!entry.expectedName.endsWith(`.${skins.PUBLIC_ASSET_EXTENSION}`)) {
      problems.push(`${entry.skinId}/${entry.mode}/${entry.view}: expected name is not .${skins.PUBLIC_ASSET_EXTENSION}`);
    }
    if (entry.publicUrl.split("/").pop() !== entry.expectedName) {
      problems.push(`${entry.skinId}/${entry.mode}/${entry.view}: URL file name does not match expected name`);
    }
  }
  if (registryUrls.size !== sources.length) problems.push("registry contains duplicate public URLs");
  return { problems, registryUrls };
}

/**
 * Manifest, committed public copies and the recorded lossless proof. Everything
 * read here ships in a release archive, so this is the part `check` owns.
 */
async function checkPublicTree(tree, sources, registryUrls) {
  const problems = [];
  const manifestRaw = await readMaybe(tree.manifestFile);
  if (!manifestRaw) {
    problems.push(`missing ${path.relative(tree.root, tree.manifestFile)}; run skins:prepare`);
    return problems;
  }

  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  const recorded = manifest.assets ?? {};
  const recordedUrls = Object.keys(recorded);
  if (recordedUrls.length !== sources.length) {
    problems.push(`manifest has ${recordedUrls.length} entries, registry expects ${sources.length}`);
  }
  for (const url of registryUrls) {
    if (!(url in recorded)) problems.push(`manifest is missing ${url}; run skins:prepare`);
  }
  for (const url of recordedUrls) {
    if (!registryUrls.has(url)) problems.push(`manifest lists ${url}, which the registry no longer expects`);
  }

  for (const entry of sources) {
    const record = recorded[entry.publicUrl];
    if (!record) continue;
    if (record.sourcePath !== entry.sourcePath) {
      problems.push(`manifest records source ${record.sourcePath}, registry expects ${entry.sourcePath}`);
    }
    const publicBytes = await readMaybe(path.join(tree.root, entry.publicPath));
    if (!publicBytes) {
      problems.push(`missing public copy ${entry.publicPath}`);
      continue;
    }
    // The copy must still be exactly the bytes that were generated and reviewed.
    if (sha256(publicBytes) !== record.publicSha256) {
      problems.push(`public copy does not match the recorded hash: ${entry.publicPath}`);
    }
    if (record.alphaMaxDelta !== 0 || record.rgbMaxDeltaVisible !== 0) {
      problems.push(
        `recorded lossless proof is not zero for ${entry.publicUrl}: alpha=${record.alphaMaxDelta} rgb=${record.rgbMaxDeltaVisible}`,
      );
    }
  }
  return problems;
}

/**
 * Bind each committed copy to the source PNG it was generated from. Only runs
 * in an authoring checkout: `lineart assets/` is export-ignored.
 */
async function checkSourceBinding(tree, sources) {
  const problems = [];
  const manifestRaw = await readMaybe(tree.manifestFile);
  if (!manifestRaw) return problems;
  const recorded = JSON.parse(manifestRaw.toString("utf8")).assets ?? {};

  for (const entry of sources) {
    const record = recorded[entry.publicUrl];
    if (!record) continue;
    const sourceBytes = await readMaybe(path.join(tree.root, entry.sourcePath));
    if (!sourceBytes) {
      problems.push(`missing source ${entry.sourcePath}`);
      continue;
    }
    // The load-bearing check: the copy must still correspond to the source it
    // was generated from. A changed source fails here rather than passing quietly.
    if (sha256(sourceBytes) !== record.sourceSha256) {
      problems.push(
        `source changed since the copies were generated: ${entry.sourcePath}; re-run ${GENERATOR_REFERENCE} then skins:prepare`,
      );
    }
  }
  return problems;
}

/** Bootstrap freshness and the single-source id/palette contract. */
async function checkBootstrap(tree) {
  const problems = [];
  const expectedBootstrap = await canonicalBootstrapText(tree);
  const bootstrapRaw = await readMaybe(tree.bootstrapFile);
  if (!bootstrapRaw) {
    problems.push(`missing ${path.relative(tree.root, tree.bootstrapFile)}; run skins:prepare`);
    return problems;
  }
  if (bootstrapRaw.toString("utf8") !== expectedBootstrap) {
    problems.push(`${path.relative(tree.root, tree.bootstrapFile)} is stale; run skins:prepare`);
  }

  // The bootstrap must not hand-maintain a second id list or palette set.
  const text = bootstrapRaw.toString("utf8");
  for (const skin of skins.SKINS) {
    if (!text.includes(`"${skin.id}"`)) problems.push(`bootstrap is missing skin id ${skin.id}`);
  }
  if (!text.includes(skins.SKIN_PREFERENCE_KEY)) problems.push("bootstrap does not reference the preference key");
  return problems;
}

/**
 * Read-only verification of one tree.
 *
 * `requireSources: false` (the `check` command) verifies only what a release
 * archive contains. `requireSources: true` (the `check-sources` command) also
 * binds the public copies to the authoring PNGs; when `lineart assets/` is
 * absent the binding is reported as `skipped`, never as verified.
 */
export async function verifySkinTree({ root = defaultRoot, requireSources = false } = {}) {
  const tree = treeAt(root);
  const sources = skins.enumerateSourceAssets();
  const registry = checkRegistry(sources);

  const problems = [...registry.problems];
  problems.push(...(await checkPublicTree(tree, sources, registry.registryUrls)));

  let sourceBinding = "skipped";
  if (requireSources && existsSync(tree.sourceRoot)) {
    sourceBinding = "verified";
    problems.push(...(await checkSourceBinding(tree, sources)));
  }

  problems.push(...(await checkBootstrap(tree)));

  return {
    status: problems.length ? "fail" : "pass",
    problems,
    sourceBinding,
    counts: { assets: sources.length, urls: registry.registryUrls.size },
  };
}

function report(result, { requireSources }) {
  if (result.status === "fail") {
    console.log(`check: FAIL (${result.problems.length} problem(s))`);
    for (const problem of result.problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const { assets, urls } = result.counts;
  console.log(`check: PASS (${assets} assets, ${urls} URLs, manifest and bootstrap fresh)`);
  if (!requireSources) return;
  if (result.sourceBinding === "verified") {
    console.log(`check-sources: PASS (${assets} sources bound to their public copies)`);
  } else {
    console.log(
      `check-sources: SKIP (${SOURCE_ROOT_NAME}/ is absent — release archive; source binding not verified)`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const command = process.argv[2];
  if (command === "prepare") await prepare(treeAt(defaultRoot));
  else if (command === "check") report(await verifySkinTree(), { requireSources: false });
  else if (command === "check-sources") report(await verifySkinTree({ requireSources: true }), { requireSources: true });
  else {
    console.error("usage: node scripts/prepare-skin-assets.mjs <prepare|check|check-sources>");
    process.exitCode = 2;
  }
}
