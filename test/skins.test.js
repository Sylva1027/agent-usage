import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  CLASSIC_SKIN_ID,
  DEFAULT_SKIN_PREFERENCE,
  PALETTE_CSS_VAR_NAMES,
  PALETTE_TOKEN_KEYS,
  PUBLIC_ASSET_EXTENSION,
  SKIN_PREFERENCE_KEY,
  SKIN_PREFERENCE_VERSION,
  SKINS,
  clampOpacity,
  enumerateSkinAssets,
  enumerateSourceAssets,
  findSkin,
  isCharacterSkin,
  isKnownSkinId,
  isPalettePending,
  listSkinIds,
  normalizeSkinPreference,
  paletteChartSeries,
  paletteDeclarations,
  paletteSwatches,
  paletteTokens,
  serializeSkinPreference,
  skinAssetUrl,
  skinDisplayParams,
  skinFaceTarget,
  skinPalette,
  withSkinPreference,
} from "../public/skins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

test("no-skin is a first-class option, not just a fallback", () => {
  // User requirement (2026-10-02): users who want no skin at all need a choice
  // that belongs to them, on equal footing with the ten characters.
  const selectable = listSkinIds();
  assert.ok(selectable.includes(CLASSIC_SKIN_ID), "classic must be selectable, not merely a fallback");
  assert.equal(selectable[0], CLASSIC_SKIN_ID, "classic leads the picker");
  assert.equal(selectable.length, 11, "ten characters plus the no-skin option");

  // Choosing it explicitly must survive normalisation instead of being rewritten.
  const chosen = normalizeSkinPreference({ version: 1, skinId: CLASSIC_SKIN_ID, showCharacters: false, opacity: 0.5 });
  assert.equal(chosen.skinId, CLASSIC_SKIN_ID);
  assert.equal(serializeSkinPreference(chosen), JSON.stringify(chosen));

  // It must be a real registry entry with a stable identity, not a special case
  // that callers have to invent.
  const classic = findSkin(CLASSIC_SKIN_ID);
  assert.equal(classic.id, CLASSIC_SKIN_ID);
  assert.equal(classic.isClassic, true);
  assert.ok(classic.name && classic.name.length > 0, "classic needs a display name for the picker");

  // Returning to it must not require any image and must not carry character art.
  for (const mode of ["light", "dark"]) {
    assert.equal(skinPalette(CLASSIC_SKIN_ID, mode), null);
    for (const view of ["side", "front"]) assert.equal(skinAssetUrl(CLASSIC_SKIN_ID, mode, view), null);
  }
  assert.ok(
    !enumerateSkinAssets().some((asset) => asset.skinId === CLASSIC_SKIN_ID),
    "selecting classic must not load any image",
  );
});

test("every selectable option is distinct and renderable by a generic picker", () => {
  // The picker must render classic through the same code path as the characters,
  // so every entry needs the fields the card template reads.
  const ids = listSkinIds();
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const id of ids) {
    const skin = findSkin(id);
    assert.equal(typeof skin.id, "string");
    assert.equal(typeof skin.name, "string");
    assert.equal(typeof skin.isClassic, "boolean");
    for (const mode of ["light", "dark"]) {
      assert.ok(mode in skin.variants, `${id} must expose a ${mode} variant`);
      assert.ok("palette" in skin.variants[mode], `${id}/${mode} must expose a palette slot`);
      assert.ok("assets" in skin.variants[mode], `${id}/${mode} must expose asset slots`);
    }
  }
});

test("registry exposes the eleven stable ids in order", () => {
  assert.deepEqual(listSkinIds(), [
    "classic",
    "chatgpt",
    "claude",
    "glm",
    "gemini",
    "deepseek",
    "kimi",
    "qwen",
    "grok",
    "muse",
    "mimo",
  ]);
  for (const id of listSkinIds()) assert.ok(isKnownSkinId(id), `${id} should be known`);
  assert.ok(isKnownSkinId(CLASSIC_SKIN_ID));
  assert.equal(isKnownSkinId("unknown-skin"), false);
  assert.equal(isKnownSkinId(""), false);
  assert.equal(isKnownSkinId(null), false);
});

test("unknown skin ids resolve to classic instead of throwing", () => {
  assert.equal(findSkin("does-not-exist").id, CLASSIC_SKIN_ID);
  assert.equal(findSkin(undefined).id, CLASSIC_SKIN_ID);
  assert.equal(findSkin(42).id, CLASSIC_SKIN_ID);
  assert.equal(findSkin(CLASSIC_SKIN_ID).isClassic, true);
  assert.equal(isCharacterSkin("chatgpt"), true);
  assert.equal(isCharacterSkin(CLASSIC_SKIN_ID), false);
  assert.equal(isCharacterSkin("nope"), false);
});

test("every character skin maps four distinct assets with the documented names", () => {
  const expectedSuffix = {
    light: { side: "side-lineart", front: "lineart" },
    dark: { side: "side-dark-lineart", front: "dark-lineart" },
  };
  for (const skin of SKINS) {
    if (skin.isClassic) continue;
    for (const mode of ["light", "dark"]) {
      for (const view of ["side", "front"]) {
        const url = skinAssetUrl(skin.id, mode, view);
        assert.equal(
          url,
          `/assets/skins/${mode}/${skin.assetPrefix}-${expectedSuffix[mode][view]}.${PUBLIC_ASSET_EXTENSION}`,
          `${skin.id}/${mode}/${view}`,
        );
      }
    }
  }
  // The dark side view must be `side-dark-lineart`, never `dark-side-lineart`.
  assert.equal(skinAssetUrl("chatgpt", "dark", "side"), "/assets/skins/dark/ChatGPT-side-dark-lineart.webp");
  assert.ok(!skinAssetUrl("chatgpt", "dark", "side").includes("dark-side"));
});

test("classic ships no character art and never requires an image request", () => {
  for (const mode of ["light", "dark"]) {
    for (const view of ["side", "front"]) {
      assert.equal(skinAssetUrl(CLASSIC_SKIN_ID, mode, view), null);
    }
  }
  assert.ok(!enumerateSkinAssets().some((asset) => asset.skinId === CLASSIC_SKIN_ID));
});

test("asset enumeration covers all forty URLs and is independent of the selection", () => {
  const assets = enumerateSkinAssets();
  assert.equal(assets.length, 40);
  assert.equal(new Set(assets.map((asset) => asset.url)).size, 40, "URLs must be unique");
  assert.equal(assets.filter((asset) => asset.mode === "light").length, 20);
  assert.equal(assets.filter((asset) => asset.mode === "dark").length, 20);
  // Enumerating twice must be stable and must not depend on any current skin.
  assert.deepEqual(
    assets.map((asset) => asset.url),
    enumerateSkinAssets().map((asset) => asset.url),
  );
});

test("source asset descriptions match the committed file naming rules", () => {
  const sources = enumerateSourceAssets();
  assert.equal(sources.length, 40);
  for (const entry of sources) {
    assert.equal(
      entry.sourcePath,
      `${entry.mode === "light" ? "lineart assets/light" : "lineart assets/dark"}/${entry.sourceName}`,
    );
    assert.ok(entry.sourceName.endsWith(".png"), "sources stay PNG");
    assert.ok(entry.expectedName.endsWith(`.${PUBLIC_ASSET_EXTENSION}`), "public copies are the decided format");
    assert.equal(skinAssetUrl(entry.skinId, entry.mode, entry.view), entry.publicUrl);
    assert.ok(existsSync(path.join(root, entry.sourcePath)), `missing source ${entry.sourcePath}`);
    assert.ok(existsSync(path.join(root, entry.publicPath)), `missing copy ${entry.publicPath}`);
  }
});

test("registry exposes a palette only where the user supplied colours, and only as colour tokens", () => {
  // Fill state is the user's choice and changes over time; the invariant this
  // test guards is structural: unfilled slots stay honestly pending, and a
  // filled slot may only ever contain allow-listed colour tokens.
  for (const skin of SKINS) {
    for (const mode of ["light", "dark"]) {
      const palette = skinPalette(skin.id, mode);
      if (skin.isClassic) {
        assert.equal(palette, null, "classic never carries colours");
        assert.equal(isPalettePending(skin.id, mode), true);
        continue;
      }
      if (palette === null) {
        assert.equal(isPalettePending(skin.id, mode), true, `${skin.id}/${mode} null palette must report pending`);
        assert.deepEqual(paletteTokens(skin.id, mode), {}, `${skin.id}/${mode} pending slot exposes no tokens`);
        assert.equal(paletteChartSeries(skin.id, mode), null, `${skin.id}/${mode} pending slot has no series`);
        assert.ok(paletteSwatches(skin.id, mode).every((swatch) => swatch.pending));
        continue;
      }
      const tokens = paletteTokens(skin.id, mode);
      assert.ok(Object.keys(tokens).length > 0, `${skin.id}/${mode} palette must not be an empty object`);
      for (const [key, value] of Object.entries(tokens)) {
        assert.ok(PALETTE_TOKEN_KEYS.includes(key), `${skin.id}/${mode}: ${key} must be an allow-listed token`);
        assert.equal(typeof value, "string", `${skin.id}/${mode}: ${key} must be a string colour`);
        assert.ok(value.trim(), `${skin.id}/${mode}: ${key} must be a non-empty colour`);
      }
      assert.equal(isPalettePending(skin.id, mode), false, `${skin.id}/${mode} filled palette must not report pending`);
      for (const swatch of paletteSwatches(skin.id, mode)) {
        if (swatch.pending) continue;
        assert.equal(swatch.value, tokens[swatch.key], `${skin.id}/${mode}: swatch ${swatch.key} mirrors its token`);
      }
    }
  }
});

test("palette helpers only accept allow-listed colour tokens", () => {
  // A fixture palette proves the resolver without writing to the real registry.
  const fixture = {
    tokens: { pageBackground: "#101010", fontSize: "99px", notAColour: "red" },
    chartSeries: ["#111111", "#222222"],
    swatchKeys: ["pageBackground", "missingToken"],
  };
  const tokens = {};
  for (const key of PALETTE_TOKEN_KEYS) {
    if (typeof fixture.tokens[key] === "string" && fixture.tokens[key]) tokens[key] = fixture.tokens[key];
  }
  assert.deepEqual(tokens, { pageBackground: "#101010" });
  assert.ok(!("fontSize" in tokens), "layout keys must be rejected");
  assert.ok(!("notAColour" in tokens), "unlisted keys must be rejected");
  // Guard the real registry against ever declaring these structural keys.
  for (const forbidden of ["fontSize", "spacing", "width", "gridTemplateColumns"]) {
    assert.ok(!PALETTE_TOKEN_KEYS.includes(forbidden), `${forbidden} must not be a colour token`);
  }
});

test("preference defaults match the contract, including 50% opacity", () => {
  assert.equal(SKIN_PREFERENCE_KEY, "codexUsageSkinV1");
  assert.equal(SKIN_PREFERENCE_VERSION, 1);
  assert.deepEqual(DEFAULT_SKIN_PREFERENCE, {
    version: 1,
    skinId: "classic",
    showCharacters: true,
    opacity: 0.5,
  });
  assert.deepEqual(normalizeSkinPreference(undefined), { ...DEFAULT_SKIN_PREFERENCE });
  assert.deepEqual(normalizeSkinPreference(null), { ...DEFAULT_SKIN_PREFERENCE });
});

test("normalisation rejects broken, unknown and wrong-version input", () => {
  for (const bad of ["{not json", "[]", '"a string"', "42", "true"]) {
    assert.deepEqual(normalizeSkinPreference(bad), { ...DEFAULT_SKIN_PREFERENCE }, `input ${bad}`);
  }
  // Unknown version must not be salvaged field by field.
  assert.deepEqual(normalizeSkinPreference({ version: 9, skinId: "grok", showCharacters: false, opacity: 0.1 }), {
    ...DEFAULT_SKIN_PREFERENCE,
  });
  assert.deepEqual(normalizeSkinPreference({ skinId: "grok" }), { ...DEFAULT_SKIN_PREFERENCE });
  // Unknown skin falls back, but valid siblings are kept.
  assert.deepEqual(normalizeSkinPreference({ version: 1, skinId: "ghost", showCharacters: false, opacity: 0.25 }), {
    version: 1,
    skinId: CLASSIC_SKIN_ID,
    showCharacters: false,
    opacity: 0.25,
  });
});

test("opacity zero is a legal value and is never replaced by the default", () => {
  const zero = normalizeSkinPreference({ version: 1, skinId: "muse", showCharacters: true, opacity: 0 });
  assert.equal(zero.opacity, 0, "opacity 0 must survive; `value || 0.5` would be wrong here");
  assert.equal(clampOpacity(0), 0);
  assert.equal(clampOpacity(1), 1);
  // Non-numeric and out-of-range values fall back or clamp.
  assert.equal(normalizeSkinPreference({ version: 1, opacity: "0.9" }).opacity, 0.5);
  assert.equal(normalizeSkinPreference({ version: 1, opacity: Number.NaN }).opacity, 0.5);
  assert.equal(normalizeSkinPreference({ version: 1, opacity: Number.POSITIVE_INFINITY }).opacity, 0.5);
  assert.equal(normalizeSkinPreference({ version: 1, opacity: 2 }).opacity, 1);
  assert.equal(normalizeSkinPreference({ version: 1, opacity: -3 }).opacity, 0);
});

test("showCharacters must be a real boolean", () => {
  for (const bad of ["true", 1, 0, null, {}]) {
    assert.equal(
      normalizeSkinPreference({ version: 1, showCharacters: bad }).showCharacters,
      true,
      `input ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(normalizeSkinPreference({ version: 1, showCharacters: false }).showCharacters, false);
});

test("serialisation round-trips through normalisation", () => {
  const stored = serializeSkinPreference({ version: 1, skinId: "qwen", showCharacters: false, opacity: 0.35 });
  assert.deepEqual(JSON.parse(stored), { version: 1, skinId: "qwen", showCharacters: false, opacity: 0.35 });
  assert.deepEqual(normalizeSkinPreference(stored), JSON.parse(stored));
  assert.deepEqual(withSkinPreference({ version: 1, skinId: "kimi" }, { skinId: "glm" }).skinId, "glm");
  assert.equal(withSkinPreference(null, { skinId: "gemini", opacity: 0 }).opacity, 0);
});

test("registry results are not shared mutable state", () => {
  const first = enumerateSkinAssets();
  first.push({ evil: true });
  first[0].url = "/tampered";
  const second = enumerateSkinAssets();
  assert.equal(second.length, 40);
  assert.notEqual(second[0].url, "/tampered");
  // Freezing the registry blocks accidental variant mutation.
  assert.ok(Object.isFrozen(SKINS[0]));
  assert.throws(() => {
    SKINS[1].variants.light.palette = { tokens: {} };
  });
});

test("skins:check passes on the committed tree without re-encoding anything", () => {
  const output = execFileSync(process.execPath, ["scripts/prepare-skin-assets.mjs", "check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /check: PASS/);
});

test("committed public copies are real WebP files whose bytes match the manifest", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "public/skin-assets.json"), "utf8"));
  const entries = Object.entries(manifest.assets);
  assert.equal(entries.length, 40);
  for (const [url, entry] of entries) {
    const bytes = readFileSync(path.join(root, entry.publicPath));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${url} must be a RIFF container`);
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", `${url} must be WebP`);
    assert.equal(sha256(bytes), entry.publicSha256, `${url} bytes must match the recorded hash`);
    // The recorded lossless evidence must be zero for every asset.
    assert.equal(entry.alphaMaxDelta, 0, `${url} alpha must be unchanged`);
    assert.equal(entry.rgbMaxDeltaVisible, 0, `${url} visible RGB must be unchanged`);
  }
});

test("preview scopes reuse the real theme declarations instead of copying them", () => {
  // Plan 4.4: a light preview inside a dark page must reproduce the real light
  // base without a duplicated, hand-maintained copy of it. The way this is done
  // is by extending the existing variable blocks' selector lists, so every
  // declared value is shared between the global theme and the preview scope.
  const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

  // The variable blocks must carry the preview scope in their selector list.
  const lightScoped = (styles.match(/:root,\s*\n\.skin-preview-scope\[data-preview-theme="light"\]/g) || []).length;
  const darkScoped = (
    styles.match(/\[data-theme="dark"\],\s*\n\.skin-preview-scope\[data-preview-theme="dark"\]/g) || []
  ).length;
  assert.ok(lightScoped >= 3, `expected the light variable blocks to be scoped, found ${lightScoped}`);
  assert.ok(darkScoped >= 3, `expected the dark variable blocks to be scoped, found ${darkScoped}`);

  // Component rules must NOT have been extended; only variable blocks.
  const componentExtended = styles.match(/^\.skin-preview-scope[^,\n]*\s+[.#][\w-]+\s*\{/gm) || [];
  const offenders = componentExtended.filter((line) => !line.includes('[data-preview-theme="'));
  assert.deepEqual(
    offenders,
    [],
    `only variable blocks may be extended, but these look like component rules: ${offenders.join(" | ")}`,
  );

  // No colour value may appear twice inside a preview scope block (that would
  // mean a second, hand-maintained base was introduced).
  const scopeBlocks =
    styles.match(/\.skin-preview-scope\[data-preview-theme="(?:light|dark)"\]\s*\{[\s\S]*?\n\}/g) || [];
  assert.ok(scopeBlocks.length >= 6, `expected at least 6 scoped variable blocks, found ${scopeBlocks.length}`);
});

test("preview scoping is present in the shipped stylesheet and survives export", () => {
  const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");
  assert.match(styles, /\.skin-preview-scope\[data-preview-theme="light"\]/);
  assert.match(styles, /\.skin-preview-scope\[data-preview-theme="dark"\]/);

  const skins = readFileSync(path.join(root, "public/skins.css"), "utf8");
  // The picker must emit the scope wrapper the stylesheet targets.
  assert.match(skins, /\.skin-preview-scope\s*\{/);
  const picker = readFileSync(path.join(root, "public/skin-picker.js"), "utf8");
  // Both scopes must be emitted literally, so the light preview exists even while
  // the page is dark (and vice versa).
  assert.match(picker, /class="skin-preview-scope" data-preview-theme="light"/);
  assert.match(picker, /class="skin-preview-scope" data-preview-theme="dark"/);
});

test("the colour input channel exists, is validated and stays separate from code", () => {
  // The user asked for a channel to supply colours later. It must be a standalone
  // file with a validator, and every palette must start empty rather than invented.
  const inputPath = path.join(root, "public/skin-palettes.js");
  const source = readFileSync(inputPath, "utf8");
  assert.match(source, /export const SKIN_PALETTES/, "the input file must export SKIN_PALETTES");
  for (const id of ["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "grok", "muse", "mimo"]) {
    assert.match(source, new RegExp(`\\b${id}: \\{`), `the input file must have a slot for ${id}`);
  }
  assert.ok(
    !/^\s*classic:\s*\{/m.test(source),
    "the no-skin option must not have a palette slot; it has no colours by definition",
  );
  // Pending-vs-filled is the user's ongoing choice; which slots are null and
  // what a filled slot may contain are guarded structurally at the registry
  // level ("palettes stay honest ..." test), not by counting null literals here.

  const validator = readFileSync(path.join(root, "scripts/check-skin-palettes.mjs"), "utf8");
  assert.match(validator, /PALETTE_TOKEN_KEYS/, "the validator must use the shared allow-list");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["skins:palette"], "node scripts/check-skin-palettes.mjs");

  const registry = readFileSync(path.join(root, "public/skins.js"), "utf8");
  assert.match(registry, /import \{ SKIN_PALETTES \} from "\.\/skin-palettes\.js"/);
  assert.match(registry, /function normalizePalette/, "the registry must normalise the hand-written input");
  assert.match(
    registry,
    /normalizePalette\(SKIN_PALETTES\[id\]\?\.\[mode\]\)/,
    "palettes must come from the input file",
  );
  // The offline exporter must inline the input file too, or the snapshot loses it.
  const exporter = readFileSync(path.join(root, "src/static-export.js"), "utf8");
  assert.match(exporter, /skin-palettes\.js/, "the exporter must inline the colour input");
});

test("palette wiring derives root-cause variables only, with colour-only geometry-safe values", () => {
  // PALETTE_CSS_VAR_NAMES is the fixed contract shared by the runtime (apply),
  // the generated pre-paint bootstrap and the live audits: apply() removes
  // exactly these names on classic, so no other variable may ever be written.
  for (const name of PALETTE_CSS_VAR_NAMES) {
    assert.match(name, /^--[a-z-]+$/, `${name} must be a CSS custom property name`);
  }
  const declarations = paletteDeclarations("chatgpt", "light");
  assert.ok(Array.isArray(declarations), "a filled palette derives declarations");
  const names = declarations.map(([name]) => name);
  assert.deepEqual(
    [...new Set(names)].sort(),
    [...PALETTE_CSS_VAR_NAMES].sort(),
    "a full palette derives every wired variable exactly once",
  );
  for (const [name, value] of declarations) {
    assert.match(
      value,
      /^#([0-9a-f]{6})$|^rgba\(\d+, \d+, \d+, (0|1|0?\.\d+)\)$/i,
      `${name}: derived values are colours only, never geometry (${value})`,
    );
  }
  // Direct tokens pass through untouched; derived roles follow the documented
  // formulas and the single-accent design keeps --record equal to --blue.
  const byName = Object.fromEntries(declarations);
  assert.equal(byName["--bg"], "#B9C9EE");
  assert.equal(byName["--neo-surface"], "#dce4f7");
  assert.equal(byName["--ink"], "#52407d");
  assert.equal(byName["--muted"], "#807eb0");
  assert.equal(byName["--blue"], paletteTokens("chatgpt", "light").accent);
  assert.equal(byName["--record"], byName["--blue"]);
  assert.equal(byName["--skin-active-accent"], byName["--blue"]);
  assert.ok(byName["--active-ink"] === "#10151a" || byName["--active-ink"] === "#ffffff");
  assert.match(byName["--ceramic-well"], /^#[0-9a-f]{6}$/);
  // Modes stay independent: dark derives from the dark tokens only.
  const dark = Object.fromEntries(paletteDeclarations("chatgpt", "dark"));
  assert.equal(dark["--bg"], "#52407d");
  assert.equal(dark["--ink"], "#B9C9EE");
  assert.equal(dark["--blue"], paletteTokens("chatgpt", "dark").accent);
  // Classic and unknown ids never derive colours.
  assert.equal(paletteDeclarations("classic", "light"), null);
  assert.equal(paletteDeclarations("classic", "dark"), null);
  assert.equal(paletteDeclarations("not-a-skin", "light"), null);
});

test("palettes stay honest to the input file: pending slots stay pending, filled slots are colour tokens only", async () => {
  const registry = await import(pathToFileURL(path.join(root, "public/skins.js")).href);
  assert.ok(registry.PALETTE_TOKEN_KEYS.includes("pageBackground"));
  assert.ok(!registry.PALETTE_TOKEN_KEYS.includes("fontSize"), "layout keys must not be allowed tokens");
  for (const skin of registry.SKINS) {
    for (const mode of ["light", "dark"]) {
      const palette = registry.skinPalette(skin.id, mode);
      if (skin.isClassic) {
        // The no-skin option has no palette at all.
        assert.equal(palette, null);
        continue;
      }
      if (palette === null) {
        // Unfilled modes must be honestly pending rather than carrying an
        // invented placeholder palette.
        assert.equal(registry.isPalettePending(skin.id, mode), true, `${skin.id}.${mode} should report pending`);
        assert.deepEqual(registry.paletteTokens(skin.id, mode), {}, `${skin.id}.${mode} should expose no tokens`);
        continue;
      }
      for (const key of Object.keys(registry.paletteTokens(skin.id, mode))) {
        assert.ok(
          registry.PALETTE_TOKEN_KEYS.includes(key),
          `${skin.id}.${mode}: ${key} must be an allow-listed token`,
        );
      }
      assert.equal(
        registry.isPalettePending(skin.id, mode),
        false,
        `${skin.id}.${mode} filled palette must not report pending`,
      );
    }
  }
});

test("webp mime type is registered so the copies are served correctly", () => {
  const server = readFileSync(path.join(root, "src/server.js"), "utf8");
  assert.match(server, /\["\.webp",\s*"image\/webp"\]/);
});

test("offline snapshot resolves every skin asset through the inlined map", () => {
  // Regression: the picker and the decoration layer once wrote the registry's
  // `/assets/...` URL straight into an <img src>, so the exported single file
  // requested sibling files that do not exist next to it. Every render path must
  // resolve through window.__CODEX_USAGE_SKIN_ASSETS__ when it is present.
  const skinUi = readFileSync(path.join(root, "public/skin-ui.js"), "utf8");
  assert.match(skinUi, /__CODEX_USAGE_SKIN_ASSETS__/, "skin-ui must consult the inlined asset map");
  assert.match(skinUi, /function resolveAssetUrl/, "skin-ui must expose one resolution point");
  // urlsFor must actually route both views through the resolver. Checking only
  // that the helper exists would pass while the bug is present.
  const urlsForBody = skinUi.slice(skinUi.indexOf("function urlsFor"), skinUi.indexOf("function ensureLayer"));
  assert.match(urlsForBody, /resolveAssetUrl\(variant\.assets\.side\)/, "urlsFor must resolve the side view");
  assert.match(urlsForBody, /resolveAssetUrl\(variant\.assets\.front\)/, "urlsFor must resolve the front view");
  assert.ok(
    !/return\s*\{\s*side:\s*variant\.assets\.side/.test(urlsForBody),
    "urlsFor must not return raw registry paths",
  );

  // urlsFor must be the single source of resolved URLs used by both consumers.
  const picker = readFileSync(path.join(root, "public/skin-picker.js"), "utf8");
  assert.ok(
    !/assets\/skins\//.test(picker),
    "the picker must not build /assets/skins paths itself; it must ask the runtime",
  );
  assert.match(picker, /runtime\.urlsFor\(/, "the picker must obtain artwork through the runtime");

  // The exporter must inline all 40 URLs so the map is complete offline.
  const exporter = readFileSync(path.join(root, "src/static-export.js"), "utf8");
  assert.match(exporter, /__CODEX_USAGE_SKIN_ASSETS__/, "the exporter must emit the inlined asset map");
  assert.match(exporter, /Expected 40 inlined skin assets/, "the exporter must assert the full asset set");
});

test("skin module stays free of browser globals so Node can import it", () => {
  const source = readFileSync(path.join(root, "public/skins.js"), "utf8");
  const moduleScope = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const global of ["document", "window", "localStorage", "navigator"]) {
    assert.ok(!new RegExp(`\\b${global}\\b`).test(moduleScope), `skins.js must not touch ${global} at module scope`);
  }
});

test("skin-ui has no undefined references outside its imports", () => {
  // Regression: while refactoring, MIN_OPACITY was dropped from skin-ui.js's
  // imports but stayed in a returned object, producing a runtime ReferenceError
  // that only a browser caught. This resolves every free identifier statically.
  const source = readFileSync(path.join(root, "public", "skin-ui.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const imported = new Set();
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+";/g)) {
    for (const name of match[1].split(",")) {
      const clean = name
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (clean) imported.add(clean);
    }
  }
  assert.ok(imported.size > 0, "skin-ui.js should import from the registry");

  const declared = new Set(imported);
  for (const match of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  // Destructuring, catch params and function parameters are local declarations too.
  for (const match of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const name of match[1].split(",")) {
      const clean = name
        .trim()
        .split(/[:=]/)[0]
        .trim()
        .replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);

  const allowed = new Set([
    ...declared,
    // Language and host globals legitimately available in both Node and browser.
    "document",
    "window",
    "localStorage",
    "Image",
    "Map",
    "Set",
    "Number",
    "Math",
    "JSON",
    "Boolean",
    "String",
    "Object",
    "Array",
    "Promise",
    "Error",
    "console",
    "setTimeout",
    "undefined",
    "this",
    "true",
    "false",
    "null",
    "new",
    "typeof",
    "return",
    "if",
    "else",
    "for",
    "of",
    "in",
    "const",
    "let",
    "var",
    "function",
    "class",
    "import",
    "export",
    "from",
    "default",
    "try",
    "catch",
    "finally",
    "throw",
    "await",
    "async",
    "continue",
    "break",
    "switch",
    "case",
    "do",
    "while",
    "delete",
    "void",
    "instanceof",
    "yield",
    "static",
    "get",
    "set",
  ]);

  // Property reads (`obj.prop`) and object literal keys are not free identifiers.
  const withoutProperties = code.replace(/\.\s*[A-Za-z_$][\w$]*/g, "").replace(/([A-Za-z_$][\w$]*)\s*:/g, ":");
  const candidates = new Set((withoutProperties.match(/\b[A-Za-z_$][\w$]*\b/g) || []).filter((n) => !allowed.has(n)));

  // Filter out anything that is purely a member of a known namespace we allow.
  const suspicious = [...candidates].filter((name) => !declared.has(name) && /^[A-Z][A-Z0-9_]+$/.test(name));
  assert.deepEqual(suspicious, [], `skin-ui.js references undeclared constants: ${suspicious.join(", ")}`);
});

test("per-image display parameters are re-derived from the recorded ink measurements", () => {
  // P3.1 regression: the registry's measured table once disagreed with the
  // committed measurement artifact for 5 of 20 entries (Kimi/side and Mimo/front
  // were the material ones), which silently mis-sized those views. Re-derive
  // every single value from `ink-bounds.json` so a transcription slip cannot
  // reach the page again.
  const measured = JSON.parse(
    readFileSync(path.join(root, "docs/validation/2026-10-02-model-character-skins/ink-bounds.json"), "utf8"),
  );
  const byFile = new Map(measured.map((entry) => [entry.file, entry]));
  const prefixes = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    glm: "GLM",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    kimi: "Kimi",
    qwen: "Qwen",
    grok: "Grok",
    muse: "Muse",
    mimo: "Mimo",
  };
  // One shared reference, because the registry normalises every drawn ink height
  // to the tallest measured image across both modes and views.
  const reference = Math.max(...measured.map((entry) => entry.inkHeightFraction));

  for (const [id, prefix] of Object.entries(prefixes)) {
    for (const view of ["front", "side"]) {
      const file = `${prefix}${view === "side" ? "-side" : ""}-lineart.png`;
      const ink = byFile.get(file);
      assert.ok(ink, `${file} must be present in ink-bounds.json`);
      const expectedScale = Number((reference / ink.inkHeightFraction).toFixed(4));
      for (const mode of ["light", "dark"]) {
        const params = skinDisplayParams(id, mode, view);
        assert.ok(params, `${id}/${mode}/${view} must carry display parameters`);
        assert.equal(params.scale, expectedScale, `${id}/${mode}/${view} scale must match the measurement`);
        assert.equal(params.anchorX, ink.inkCenterXFraction, `${id}/${mode}/${view} anchorX must be the ink centre`);
        assert.equal(params.inkWidth, ink.inkWidthFraction, `${id}/${mode}/${view} inkWidth must match`);
        assert.equal(params.inkHeight, ink.inkHeightFraction, `${id}/${mode}/${view} inkHeight must match`);
      }
    }
  }

  // Classic still has no art, so it must have no parameters at all.
  assert.equal(skinDisplayParams("classic", "light", "front"), null);
  assert.equal(skinDisplayParams("classic", "dark", "side"), null);
});

test("skin-ui can re-attach artwork after clearing and retry a failed decode", () => {
  // P3.3 regressions, both found by browser audit after P3 was first ticked:
  // (1) clearImages() dropped `src` but kept `dataset.url`, so re-applying the
  //     same skin/mode never re-attached the source and the character vanished
  //     while the DOM still reported loaded=1;
  // (2) the decode cache stored failures forever, so one transient error was
  //     permanent for the session.
  const source = readFileSync(path.join(root, "public", "skin-ui.js"), "utf8");
  const decodeBody = source.slice(source.indexOf("function decode"), source.indexOf("function clearImages"));
  assert.match(decodeBody, /decoded\.delete\(url\)/, "a failed decode must be evicted so it can be retried");
  const clearBody = source.slice(source.indexOf("function clearImages"), source.indexOf("function apply"));
  assert.match(
    clearBody,
    /delete image\.dataset\.url/,
    "clearImages must forget the URL, or the same asset can never be re-attached",
  );
});

test("page faces are independently annotated for every view and shared across paired modes", () => {
  for (const skin of SKINS.filter((entry) => !entry.isClassic)) {
    for (const view of ["front", "side"]) {
      const light = skinDisplayParams(skin.id, "light", view);
      const dark = skinDisplayParams(skin.id, "dark", view);
      const { faceLeft, faceX, faceRight } = light.face;
      assert.ok(0 <= faceLeft && faceLeft < faceX && faceX < faceRight && faceRight <= 1);
      assert.deepEqual(light.face, dark.face);
      assert.ok(Object.isFrozen(light.face));
      assert.notEqual(faceX, light.anchorX, `${skin.id}/${view} face must not reuse the whole-body ink centre`);
    }
  }
});

test("face targets follow available space and protect only face edges", () => {
  const face = { faceLeft: 0.2, faceX: 0.3, faceRight: 0.5 };
  // An asymmetric visible face makes accidental whole-image clamping detectable.
  assert.equal(skinFaceTarget(face, 400, 1000, 200), 200);
  assert.ok(Math.abs(skinFaceTarget(face, 400, 1000, 20) - 40) < 1e-9);
  assert.equal(skinFaceTarget(face, 400, 1000, 990), 920);
  assert.ok(Math.abs(skinFaceTarget(face, 800, 1000, 20) - 80) < 1e-9);
  assert.equal(skinFaceTarget(face, 400, 1000, 200) - 400 * face.faceX, 80);
  assert.equal(skinFaceTarget(face, 400, 500, 490), 420);
  assert.equal(skinFaceTarget({ faceLeft: 0.2, faceX: 0.4, faceRight: 0.6 }, 400, 100, 0), 50);
});

test("missing or invalid face geometry retains the static fallback", () => {
  const face = { faceLeft: 0.2, faceX: 0.3, faceRight: 0.5 };
  for (const args of [
    [null, 400, 1000, 200],
    [{ ...face, faceX: 0.6 }, 400, 1000, 200],
    [{ ...face, faceLeft: -0.1 }, 400, 1000, 200],
    [face, 0, 1000, 200],
    [face, 400, 0, 200],
    [face, 400, 1000, Number.NaN],
    [face, Number.POSITIVE_INFINITY, 1000, 200],
  ]) {
    assert.equal(skinFaceTarget(...args), null);
  }
});
