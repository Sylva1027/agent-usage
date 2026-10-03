/**
 * Skin asset preparation and verification (implementation plan 5 and 3.4).
 *
 *   node scripts/prepare-skin-assets.mjs prepare   # write derived artifacts
 *   node scripts/prepare-skin-assets.mjs check     # read-only verification
 *
 * Scope and honest limits:
 *   - Node has no built-in image encoder, and these commands may only use built-in
 *     fs/path without adding production dependencies. So this script never
 *     re-encodes the 40 public WebP copies. Those come from the one-off
 *     development generator documented in plan 3.4.
 *   - `prepare` derives everything that follows from the registry: the asset
 *     manifest (with expected hashes) and the synchronous bootstrap script.
 *   - `check` verifies the committed copies against the sources, the registry
 *     extension contract, manifest freshness and bootstrap freshness, and exits
 *     non-zero on any problem. A changed source therefore fails the check
 *     instead of being silently ignored.
 *
 * The generated bootstrap is emitted already formatted, so `format:check` stays
 * meaningful; `check` compares against that same canonical text.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const manifestFile = path.join(publicDir, "skin-assets.json");
const bootstrapFile = path.join(publicDir, "skin-bootstrap.js");

const GENERATOR_REFERENCE = "docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py";

const skins = await import(pathToFileURL(path.join(publicDir, "skins.js")).href);

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
async function formatGenerated(file) {
  const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
  if (!existsSync(biome)) return false;
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [biome, "format", "--write", file], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

/**
 * The canonical text of the generated bootstrap: emit it, format it, read back
 * what the formatter produced. Cached so prepare and check agree exactly.
 */
let canonicalBootstrapCache = null;
async function canonicalBootstrapText() {
  if (canonicalBootstrapCache !== null) return canonicalBootstrapCache;
  const raw = bootstrapSource();
  const probe = `${bootstrapFile}.probe-${process.pid}`;
  await writeAtomic(probe, raw);
  const formatted = (await formatGenerated(probe)) === false ? raw : (await readMaybe(probe)).toString("utf8");
  const { rm } = await import("node:fs/promises");
  await rm(probe, { force: true });
  canonicalBootstrapCache = formatted;
  return formatted;
}

function formatConfigJson(value, indent = 2) {
  // Emitted through JSON.stringify; the committed form is whatever the
  // repository formatter produces (see biome.json, which excludes this
  // generated artifact). `check` compares that exact canonical text.
  return JSON.stringify(value);
}

/** Derived bootstrap: same registry, no second hand-written id list or palette. */
function bootstrapSource() {
  const registry = skins.SKINS.map((skin) => ({
    id: skin.id,
    name: skin.name,
    isClassic: skin.isClassic,
    light: skin.variants.light.assets,
    dark: skin.variants.dark.assets,
    // Whole-page palette declarations, derived here from the same registry
    // helpers the runtime uses, so the first painted frame already carries the
    // skin's colours (page background, surfaces, text, accent) with no flash.
    palette: skin.isClassic
      ? null
      : {
          light: skins.paletteDeclarations(skin.id, "light"),
          dark: skins.paletteDeclarations(skin.id, "dark"),
        },
  }));
  const payload = {
    key: skins.SKIN_PREFERENCE_KEY,
    version: skins.SKIN_PREFERENCE_VERSION,
    defaultPreference: skins.DEFAULT_SKIN_PREFERENCE,
    modes: skins.SKIN_MODES,
    paletteVarNames: skins.PALETTE_CSS_VAR_NAMES,
    registry,
  };
  return `// Generated by scripts/prepare-skin-assets.mjs from public/skins.js.
// Do not edit by hand; run \`npm.cmd run skins:prepare\`.
// Placed before the stylesheet so the restored skin applies before first paint.
(() => {
  const CONFIG = ${formatConfigJson(payload)};
  const root = document.documentElement;
  const byId = new Map(CONFIG.registry.map((skin) => [skin.id, skin]));

  function clampOpacity(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return CONFIG.defaultPreference.opacity;
    return Math.min(1, Math.max(0, value));
  }

  function normalize(raw) {
    const fallback = {
      version: CONFIG.version,
      skinId: CONFIG.defaultPreference.skinId,
      showCharacters: CONFIG.defaultPreference.showCharacters,
      opacity: CONFIG.defaultPreference.opacity,
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
    if (raw.version !== CONFIG.version) return fallback;
    return {
      version: CONFIG.version,
      skinId: byId.has(raw.skinId) ? raw.skinId : fallback.skinId,
      showCharacters: typeof raw.showCharacters === "boolean" ? raw.showCharacters : fallback.showCharacters,
      opacity: clampOpacity(raw.opacity),
    };
  }

  let preference;
  try {
    preference = normalize(JSON.parse(localStorage.getItem(CONFIG.key)));
  } catch {
    preference = normalize(null);
  }

  const skin = byId.get(preference.skinId) || byId.get(CONFIG.defaultPreference.skinId);
  const isCharacter = Boolean(skin) && !skin.isClassic;
  const theme = root.dataset.theme === "dark" ? "dark" : "light";
  // Exposed so the DOM module can adopt the exact URLs the pre-paint script
  // resolved, without re-deriving them from a second configuration.
  const assets = isCharacter ? skin[theme] : null;

  root.dataset.skin = preference.skinId;
  root.dataset.skinCharacters = isCharacter && preference.showCharacters ? "on" : "off";
  root.dataset.skinOpacity = String(preference.opacity);
  root.dataset.skinTheme = theme;
  // Whole-page palette: clear every palette-driven variable, then apply the
  // current skin/mode's declarations so nothing from an earlier state (or a
  // default accent) can survive into first paint.
  for (const name of CONFIG.paletteVarNames) root.style.removeProperty(name);
  const palette = isCharacter ? skin.palette?.[theme] : null;
  if (palette) {
    for (const [name, value] of palette) root.style.setProperty(name, value);
  }
  if (assets) {
    if (assets.side) root.dataset.skinSideAsset = assets.side;
    if (assets.front) root.dataset.skinFrontAsset = assets.front;
  }
  // Marks where the pre-paint script ran so the DOM module can adopt the same state.
  root.dataset.skinBootstrap = "1";
})();
`;
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

async function prepare() {
  const expected = expectedManifest();
  const existing = JSON.parse((await readMaybe(manifestFile))?.toString("utf8") ?? "null");
  const assets = {};
  const missing = [];

  for (const [url, entry] of Object.entries(expected)) {
    const sourceBytes = await readMaybe(path.join(root, entry.sourcePath));
    const publicBytes = await readMaybe(path.join(root, entry.publicPath));
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
  await writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const bootstrap = await canonicalBootstrapText();
  const currentBootstrap = await readMaybe(bootstrapFile);
  const bootstrapChanged = currentBootstrap?.toString("utf8") !== bootstrap;
  if (bootstrapChanged) await writeAtomic(bootstrapFile, bootstrap);

  console.log(`prepare: ${Object.keys(assets).length} assets recorded`);
  console.log(`prepare: wrote ${path.relative(root, manifestFile)}`);
  console.log(`prepare: ${bootstrapChanged ? "wrote" : "unchanged"} ${path.relative(root, bootstrapFile)}`);
  if (missing.length) {
    console.log(`prepare: ${missing.length} file(s) missing:`);
    for (const file of missing) console.log(`  ${file}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function check() {
  const problems = [];
  const sources = skins.enumerateSourceAssets();

  if (sources.length !== 40) problems.push(`registry enumerates ${sources.length} source assets, expected 40`);

  const registryUrls = new Set();
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

  const manifestRaw = await readMaybe(manifestFile);
  if (!manifestRaw) {
    problems.push(`missing ${path.relative(root, manifestFile)}; run skins:prepare`);
  } else {
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
      const sourceBytes = await readMaybe(path.join(root, entry.sourcePath));
      const publicBytes = await readMaybe(path.join(root, entry.publicPath));
      if (!sourceBytes) {
        problems.push(`missing source ${entry.sourcePath}`);
        continue;
      }
      if (!publicBytes) {
        problems.push(`missing public copy ${entry.publicPath}`);
        continue;
      }
      // The load-bearing check: the copy must still correspond to the source it
      // was generated from. A changed source fails here rather than passing quietly.
      if (sha256(sourceBytes) !== record.sourceSha256) {
        problems.push(
          `source changed since the copies were generated: ${entry.sourcePath}; re-run ${GENERATOR_REFERENCE} then skins:prepare`,
        );
      }
      if (sha256(publicBytes) !== record.publicSha256) {
        problems.push(`public copy does not match the recorded hash: ${entry.publicPath}`);
      }
      if (record.alphaMaxDelta !== 0 || record.rgbMaxDeltaVisible !== 0) {
        problems.push(`recorded lossless proof is not zero for ${entry.publicUrl}: alpha=${record.alphaMaxDelta} rgb=${record.rgbMaxDeltaVisible}`);
      }
    }
  }

  const expectedBootstrap = await canonicalBootstrapText();
  const bootstrapRaw = await readMaybe(bootstrapFile);
  if (!bootstrapRaw) {
    problems.push(`missing ${path.relative(root, bootstrapFile)}; run skins:prepare`);
  } else if (bootstrapRaw.toString("utf8") !== expectedBootstrap) {
    problems.push(`${path.relative(root, bootstrapFile)} is stale; run skins:prepare`);
  }

  // The bootstrap must not hand-maintain a second id list or palette set.
  if (bootstrapRaw) {
    const text = bootstrapRaw.toString("utf8");
    for (const skin of skins.SKINS) {
      if (!text.includes(`"${skin.id}"`)) problems.push(`bootstrap is missing skin id ${skin.id}`);
    }
    if (!text.includes(skins.SKIN_PREFERENCE_KEY)) problems.push("bootstrap does not reference the preference key");
  }

  if (problems.length) {
    console.log(`check: FAIL (${problems.length} problem(s))`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check: PASS (${sources.length} assets, ${registryUrls.size} URLs, manifest and bootstrap fresh)`);
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "check") await check();
else {
  console.error("usage: node scripts/prepare-skin-assets.mjs <prepare|check>");
  process.exitCode = 2;
}
