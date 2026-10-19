/**
 * Pure bootstrap emitter (implementation plan M1.2).
 *
 * Builds the pre-paint bootstrap source from the live skin registry without
 * touching the filesystem: same registry, no second hand-written id list or
 * palette. `prepare-skin-assets.mjs` writes the default output to
 * public/skin-bootstrap.js; dev previews call this in memory with
 * `paletteOverrides` instead of re-running the generator against production
 * files. Importing this module must not execute prepare/check or write probes
 * — everything here is pure string building.
 *
 * `paletteOverrides` maps a character skin id to a complete light+dark token
 * pair (`{ light: tokens, dark: tokens }`). Overridden skins get their palette
 * derived through the M1.1 pure entry point
 * (`derivePaletteDeclarationsFromTokens`); every other skin keeps the official
 * values from `paletteDeclarations`. Validation is strict on purpose: unknown
 * ids, classic, half sets, unknown mode keys or colour values that fail the
 * M0 token contract throw instead of being silently ignored. Own-property
 * semantics throughout (复核更正): `in` and ordinary reads traverse the
 * prototype chain, so light/dark must be own properties of the mode object,
 * all twelve tokens must be own properties of the token object, and emission
 * only reads verified own skin entries — an inherited entry is not input.
 */

import { SKIN_IDS, validateTokens } from "./contracts.mjs";
import {
  DEFAULT_SKIN_PREFERENCE,
  PALETTE_CSS_VAR_NAMES,
  PALETTE_TOKEN_KEYS,
  SKINS,
  SKIN_MODES,
  SKIN_PREFERENCE_KEY,
  SKIN_PREFERENCE_VERSION,
  derivePaletteDeclarationsFromTokens,
  paletteDeclarations,
} from "../../public/skins.js";

const OVERRIDE_MODES = ["light", "dark"];

/**
 * Validate `paletteOverrides` and return its verified own entries as a Map.
 * Skin entries must be own enumerable properties of the overrides object;
 * light/dark must be own properties of the mode object; all twelve tokens
 * must be own properties of the token object (原型链上的值不作为已提供，否则
 * 共享校验器经普通属性读取会把继承值当作输入). The returned token objects are
 * own-key snapshots, so emission never reads anything but verified own values.
 */
function verifiedOverrides(paletteOverrides) {
  if (paletteOverrides === null || typeof paletteOverrides !== "object" || Array.isArray(paletteOverrides)) {
    throw new TypeError("paletteOverrides 必须是 { [skinId]: { light, dark } } 映射");
  }
  const verified = new Map();
  for (const skinId of Object.keys(paletteOverrides)) {
    if (!SKIN_IDS.includes(skinId)) {
      throw new Error(`paletteOverrides 的 "${skinId}" 不是十套角色皮肤（classic 不可覆盖）`);
    }
    const modes = paletteOverrides[skinId];
    if (!modes || typeof modes !== "object" || Array.isArray(modes)) {
      throw new TypeError(`paletteOverrides.${skinId} 必须是 { light, dark } 形状`);
    }
    for (const key of Object.keys(modes)) {
      if (!OVERRIDE_MODES.includes(key)) {
        throw new Error(`paletteOverrides.${skinId} 出现未知模式 "${key}"（只接受 light 与 dark）`);
      }
    }
    const pair = {};
    for (const mode of OVERRIDE_MODES) {
      if (!Object.hasOwn(modes, mode)) {
        throw new Error(`paletteOverrides.${skinId} 缺少自有属性 ${mode}——override 必须同时以自有属性提供完整浅深两套`);
      }
      const tokens = modes[mode];
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
        throw new TypeError(`paletteOverrides.${skinId}.${mode} 必须是 12 键 token 对象`);
      }
      for (const key of PALETTE_TOKEN_KEYS) {
        if (!Object.hasOwn(tokens, key)) {
          throw new Error(`paletteOverrides.${skinId}.${mode} 的 ${key} 不是自有属性（原型链上的值不作为已提供）`);
        }
      }
      const result = validateTokens(tokens);
      if (!result.valid) {
        const detail = result.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ");
        throw new Error(`paletteOverrides.${skinId}.${mode} 未通过 M0 严格 token 校验：${detail}`);
      }
      const ownTokens = {};
      for (const key of PALETTE_TOKEN_KEYS) ownTokens[key] = tokens[key];
      pair[mode] = ownTokens;
    }
    verified.set(skinId, pair);
  }
  return verified;
}

/**
 * The canonical bootstrap source. With no overrides this is byte-identical to
 * what `prepare` writes (after the repository formatter, which is applied by
 * the caller); with overrides only the affected skins' palettes change.
 */
export function buildSkinBootstrapSource(paletteOverrides = {}) {
  const overrides = verifiedOverrides(paletteOverrides);
  const paletteFor = (skinId, mode) => {
    const override = overrides.get(skinId);
    if (override) return derivePaletteDeclarationsFromTokens(override[mode], mode);
    return paletteDeclarations(skinId, mode);
  };
  const registry = SKINS.map((skin) => ({
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
          light: paletteFor(skin.id, "light"),
          dark: paletteFor(skin.id, "dark"),
        },
  }));
  const payload = {
    key: SKIN_PREFERENCE_KEY,
    version: SKIN_PREFERENCE_VERSION,
    defaultPreference: DEFAULT_SKIN_PREFERENCE,
    modes: SKIN_MODES,
    paletteVarNames: PALETTE_CSS_VAR_NAMES,
    registry,
  };
  return `// Generated by scripts/prepare-skin-assets.mjs from public/skins.js.
// Do not edit by hand; run \`npm.cmd run skins:prepare\`.
// Placed before the stylesheet so the restored skin applies before first paint.
(() => {
  const CONFIG = ${JSON.stringify(payload)};
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
