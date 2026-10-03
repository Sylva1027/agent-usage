/**
 * Model character skin registry and pure preference helpers.
 *
 * Pure configuration only: no document, window, localStorage or DOM access at
 * module scope, so this module can be imported by Node (tests, the asset
 * preparation script) and by the browser alike. The generated
 * `public/skin-bootstrap.js` is derived from this same registry, so skin ids,
 * defaults and validation exist in exactly one place.
 *
 * Colour decisions: every theme keeps its own `light` and `dark` palette slot.
 * Both remain `null` until the user supplies real colours per theme and mode;
 * nothing here invents, derives or copies colours.
 */

export const SKIN_PREFERENCE_KEY = "codexUsageSkinV1";
export const SKIN_PREFERENCE_VERSION = 1;

/** Classic is not a character theme: it keeps the project's existing look. */
export const CLASSIC_SKIN_ID = "classic";

export const DEFAULT_SKIN_PREFERENCE = Object.freeze({
  version: SKIN_PREFERENCE_VERSION,
  skinId: CLASSIC_SKIN_ID,
  showCharacters: true,
  opacity: 0.5,
});

export const SKIN_MODES = Object.freeze(["light", "dark"]);
export const CHARACTER_VIEWS = Object.freeze(["side", "front"]);

export const MIN_OPACITY = 0;
export const MAX_OPACITY = 1;

/**
 * Public copies are deterministic lossless encodings of the source PNGs:
 * RGBA -> grayscale+alpha, then WebP lossless. See implementation plan 3.4.
 * The extension here must match the committed copies; `skins:check` enforces it.
 */
export const PUBLIC_ASSET_EXTENSION = "webp";

/** Source file name per mode and view. `{n}` is the asset prefix. */
export const SOURCE_FILE_PATTERNS = Object.freeze({
  light: Object.freeze({
    side: "{n}-side-lineart.png",
    front: "{n}-lineart.png",
  }),
  dark: Object.freeze({
    side: "{n}-side-dark-lineart.png",
    front: "{n}-dark-lineart.png",
  }),
});

export const SOURCE_DIRECTORIES = Object.freeze({
  light: "lineart assets/light",
  dark: "lineart assets/dark",
});

/**
 * Semantic colour slots a user palette may set. Keys are a deliberate
 * allow-list: colour configuration may never touch fonts, sizes, spacing or
 * layout variables.
 */
export const PALETTE_TOKEN_KEYS = Object.freeze([
  "pageBackground",
  "panelBackground",
  "panelBorder",
  "panelHighlight",
  "panelShadow",
  "textPrimary",
  "textSecondary",
  "accent",
  "controlBackground",
  "controlBorder",
  "controlText",
  "chartText",
]);

// The user-owned colour input. Kept in a separate file so filling in colours
// never requires editing code; `npm run skins:palette` validates it.
import { SKIN_PALETTES } from "./skin-palettes.js";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Normalise one mode's palette from the user input file into registry shape.
 *
 * The input file (public/skin-palettes.js) is written by hand, so it uses the
 * simplest possible shape: flat colour tokens plus an optional `chartSeries`
 * array. Anything not allow-listed is dropped here rather than reaching CSS, so
 * a typo can never change layout. `null` stays `null`, which is the honest
 * "colours pending" state.
 */
function normalizePalette(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tokens = {};
  for (const key of PALETTE_TOKEN_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) tokens[key] = value.trim();
  }
  const series = Array.isArray(raw.chartSeries)
    ? raw.chartSeries.filter((colour) => typeof colour === "string" && colour.trim()).map((colour) => colour.trim())
    : null;
  if (!Object.keys(tokens).length && !series?.length) return null;
  return { tokens, chartSeries: series?.length ? series : null };
}

// ---------------------------------------------------------------------------
// Per-image display parameters (plan 3.3 / P3.1)
//
// Measured from the source PNGs' ink bounding boxes by
// docs/validation/2026-10-02-model-character-skins/measure-ink-bounds.py
// (alpha >= 32), recorded in that directory's `ink-bounds.json`. Values are
// fractions of the canvas, so they survive any future re-export at a different
// resolution. Both modes share one measurement set because the light/dark files
// have byte-identical alpha masks (P0.3).
//
// Front-view ink height is nearly constant across characters (0.980 .. 0.993),
// but ink WIDTH varies a lot (0.567 .. 0.990): some silhouettes are narrow with
// wide side margins. Anchoring naively by canvas would therefore render Mimo and
// Muse visibly smaller than the rest, so each image carries its own measurement.
//
// The height factor `scale` normalises the drawn ink height; it scales the whole
// image uniformly, because width differences are the silhouette itself and
// stretching them away would distort the art. `cx` is the ink's horizontal
// centre, used by the stylesheet to align the INK centre to the viewport edge
// instead of the canvas centre, which would drift with uneven side margins.
//
// These numbers must stay identical to `ink-bounds.json`; test/skins.test.js
// re-derives them from that file and fails on any divergence, so a transcription
// slip can never reach the page again.
// ---------------------------------------------------------------------------
const MEASURED_INK = {
  ChatGPT: { front: { w: 0.96068, h: 0.985646, cx: 0.504782 }, side: { w: 0.920298, h: 0.994617, cx: 0.534538 } },
  Claude: { front: { w: 0.98406, h: 0.992819, cx: 0.503719 }, side: { w: 0.980871, h: 0.987433, cx: 0.502125 } },
  DeepSeek: { front: { w: 0.953241, h: 0.986244, cx: 0.507439 }, side: { w: 0.97237, h: 0.982645, cx: 0.503188 } },
  GLM: { front: { w: 0.893555, h: 0.992839, cx: 0.507324 }, side: { w: 0.912109, h: 0.990234, cx: 0.512695 } },
  Gemini: { front: { w: 0.954102, h: 0.990234, cx: 0.500488 }, side: { w: 0.981934, h: 0.985048, cx: 0.501594 } },
  Kimi: { front: { w: 0.953125, h: 0.98763, cx: 0.511719 }, side: { w: 0.990436, h: 0.974267, cx: 0.503719 } },
  Qwen: { front: { w: 0.97237, h: 0.985646, cx: 0.503188 }, side: { w: 0.955367, h: 0.977273, cx: 0.519129 } },
  Grok: { front: { w: 0.987248, h: 0.983254, cx: 0.506376 }, side: { w: 0.971307, h: 0.98445, cx: 0.50797 } },
  Muse: { front: { w: 0.912109, h: 0.992839, cx: 0.505859 }, side: { w: 0.756836, h: 0.988932, cx: 0.574707 } },
  Mimo: { front: { w: 0.567383, h: 0.979818, cx: 0.502441 }, side: { w: 0.688477, h: 0.988281, cx: 0.596191 } },
};

// Manually marked visible face boundaries, as fractions of the SOURCE canvas.
// These are independent of the measured whole-body ink and picker composition.
// Light/dark pairs share identical alpha masks. Source views and calibration
// guides: docs/validation/2026-10-02-skin-face-centering/.
const PAGE_FACE_BOUNDS = {
  ChatGPT: { front: [0.4, 0.51], side: [0.35, 0.46] },
  Claude: { front: [0.425, 0.535], side: [0.36, 0.48] },
  GLM: { front: [0.435, 0.545], side: [0.32, 0.45] },
  Gemini: { front: [0.43, 0.56], side: [0.38, 0.51] },
  DeepSeek: { front: [0.42, 0.56], side: [0.35, 0.48] },
  Kimi: { front: [0.46, 0.57], side: [0.395, 0.485] },
  Qwen: { front: [0.42, 0.54], side: [0.38, 0.47] },
  Grok: { front: [0.48, 0.62], side: [0.35, 0.46] },
  Muse: { front: [0.42, 0.55], side: [0.35, 0.48] },
  Mimo: { front: [0.425, 0.535], side: [0.31, 0.42] },
};

function pageFaceFor(assetPrefix, view) {
  const bounds = PAGE_FACE_BOUNDS[assetPrefix]?.[view];
  if (!bounds) return null;
  const [faceLeft, faceRight] = bounds;
  return { faceLeft, faceRight, faceX: (faceLeft + faceRight) / 2 };
}

/** Clamp only the face to the viewport; the body may extend under the board. */
export function skinFaceTarget(face, imageWidth, layerWidth, targetX) {
  if (
    !face ||
    ![face.faceLeft, face.faceX, face.faceRight, imageWidth, layerWidth, targetX].every(Number.isFinite) ||
    face.faceLeft < 0 ||
    face.faceLeft >= face.faceX ||
    face.faceX >= face.faceRight ||
    face.faceRight > 1 ||
    imageWidth <= 0 ||
    layerWidth <= 0
  ) {
    return null;
  }
  const min = (face.faceX - face.faceLeft) * imageWidth;
  const max = layerWidth - (face.faceRight - face.faceX) * imageWidth;
  // An extreme viewport shorter than the face has no fully visible solution.
  // Centre its visible portion instead of stretching the artwork or returning NaN.
  return min > max ? layerWidth / 2 : Math.min(max, Math.max(min, targetX));
}

// The tallest drawn ink among the ten characters; every image is scaled up so its
// own ink height matches this, which is what makes the set look consistent.
const REFERENCE_INK_HEIGHT = Math.max(...Object.values(MEASURED_INK).flatMap((views) => [views.front.h, views.side.h]));

/**
 * Display parameters for one image, derived purely from the measured ink box.
 *
 * `scale` grows the whole image uniformly so its drawn ink reaches the reference
 * height. A uniform scale is deliberate: ink width varies across characters
 * because the silhouettes genuinely differ (Mimo's figure is narrower than
 * Grok's), and stretching that away would distort the art. What must be
 * consistent is the drawn HEIGHT, which is what `scale` normalises.
 *
 * `anchorX` centres on the ink rather than the canvas, so uneven side margins do
 * not push a character off-centre.
 */
function displayParamsFor(assetPrefix, view) {
  const measured = MEASURED_INK[assetPrefix]?.[view];
  if (!measured) {
    // An unmeasured image still renders, at neutral parameters, rather than
    // disappearing or being sized by a guess.
    return deepFreeze({ scale: 1, anchorX: 0.5, anchorY: 1, inkWidth: null, inkHeight: null });
  }
  return deepFreeze({
    scale: Number((REFERENCE_INK_HEIGHT / measured.h).toFixed(4)),
    anchorX: measured.cx,
    anchorY: 1,
    inkWidth: measured.w,
    inkHeight: measured.h,
    face: pageFaceFor(assetPrefix, view),
  });
}

function characterSkin(id, name, assetPrefix) {
  const assetsFor = (mode) => ({
    side: `/assets/skins/${mode}/${assetPrefix}-${SOURCE_FILE_PATTERNS[mode].side.replace("{n}", assetPrefix).slice(assetPrefix.length + 1, -4)}.${PUBLIC_ASSET_EXTENSION}`,
    front: `/assets/skins/${mode}/${assetPrefix}-${SOURCE_FILE_PATTERNS[mode].front.replace("{n}", assetPrefix).slice(assetPrefix.length + 1, -4)}.${PUBLIC_ASSET_EXTENSION}`,
  });
  const paletteFor = (mode) => normalizePalette(SKIN_PALETTES[id]?.[mode]);
  const displayFor = () => ({
    side: displayParamsFor(assetPrefix, "side"),
    front: displayParamsFor(assetPrefix, "front"),
  });
  return deepFreeze({
    id,
    name,
    assetPrefix,
    isClassic: false,
    variants: {
      light: { assets: assetsFor("light"), palette: paletteFor("light"), display: displayFor() },
      dark: { assets: assetsFor("dark"), palette: paletteFor("dark"), display: displayFor() },
    },
  });
}

const classic = deepFreeze({
  id: CLASSIC_SKIN_ID,
  name: "Classic",
  assetPrefix: null,
  isClassic: true,
  variants: {
    light: { assets: { side: null, front: null }, palette: null },
    dark: { assets: { side: null, front: null }, palette: null },
  },
});

/** Registry order is stable and is the order shown in the picker. */
export const SKINS = Object.freeze([
  classic,
  characterSkin("chatgpt", "ChatGPT", "ChatGPT"),
  characterSkin("claude", "Claude", "Claude"),
  characterSkin("glm", "GLM", "GLM"),
  characterSkin("gemini", "Gemini", "Gemini"),
  characterSkin("deepseek", "DeepSeek", "DeepSeek"),
  characterSkin("kimi", "Kimi", "Kimi"),
  characterSkin("qwen", "Qwen", "Qwen"),
  characterSkin("grok", "Grok", "Grok"),
  characterSkin("muse", "Muse", "Muse"),
  characterSkin("mimo", "Mimo", "Mimo"),
]);

const SKINS_BY_ID = new Map(SKINS.map((skin) => [skin.id, skin]));

export function listSkinIds() {
  return SKINS.map((skin) => skin.id);
}

export function isKnownSkinId(skinId) {
  return typeof skinId === "string" && SKINS_BY_ID.has(skinId);
}

/** Unknown or malformed ids fall back to classic; never returns undefined. */
export function findSkin(skinId) {
  return (typeof skinId === "string" && SKINS_BY_ID.get(skinId)) || SKINS_BY_ID.get(CLASSIC_SKIN_ID);
}

export function isKnownMode(mode) {
  return SKIN_MODES.includes(mode);
}

export function isKnownView(view) {
  return CHARACTER_VIEWS.includes(view);
}

/** Resolve one theme variant; `mode` is the page theme, defaulting to light. */
export function skinVariant(skinId, mode) {
  const skin = findSkin(skinId);
  return skin.variants[isKnownMode(mode) ? mode : "light"];
}

/** Resolve a single asset URL, or null for classic (no character art). */
export function skinAssetUrl(skinId, mode, view) {
  if (!isKnownView(view)) return null;
  return skinVariant(skinId, mode).assets[view] ?? null;
}

/** True when the skin actually ships character art. */
export function isCharacterSkin(skinId) {
  return !findSkin(skinId).isClassic;
}

export function clampOpacity(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SKIN_PREFERENCE.opacity;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value));
}

/**
 * Normalise a stored preference. Anything unsupported (wrong version, broken
 * JSON, unknown skin, wrong types) degrades to the classic default instead of
 * propagating a bad structure. `opacity: 0` is a legal value and must survive.
 */
export function normalizeSkinPreference(raw) {
  let candidate = raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ...DEFAULT_SKIN_PREFERENCE };
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ...DEFAULT_SKIN_PREFERENCE };
  }
  if (candidate.version !== SKIN_PREFERENCE_VERSION) {
    return { ...DEFAULT_SKIN_PREFERENCE };
  }
  return {
    version: SKIN_PREFERENCE_VERSION,
    skinId: isKnownSkinId(candidate.skinId) ? candidate.skinId : CLASSIC_SKIN_ID,
    showCharacters:
      typeof candidate.showCharacters === "boolean" ? candidate.showCharacters : DEFAULT_SKIN_PREFERENCE.showCharacters,
    opacity: clampOpacity(candidate.opacity),
  };
}

/** Serialise a preference for storage, always normalised first. */
export function serializeSkinPreference(raw) {
  return JSON.stringify(normalizeSkinPreference(raw));
}

/** Build a preference object from partial user intent. */
export function withSkinPreference(current, patch = {}) {
  return normalizeSkinPreference({ ...normalizeSkinPreference(current), ...patch });
}

/**
 * Every public asset URL in registry order, regardless of what is selected.
 * The offline export must inline all of these, so enumeration cannot depend on
 * the current skin or theme.
 */
export function enumerateSkinAssets() {
  const entries = [];
  for (const skin of SKINS) {
    if (skin.isClassic) continue;
    for (const mode of SKIN_MODES) {
      for (const view of CHARACTER_VIEWS) {
        const url = skin.variants[mode].assets[view];
        if (url) entries.push({ skinId: skin.id, mode, view, url });
      }
    }
  }
  return entries;
}

/**
 * Source description for one asset, used by the preparation and check scripts.
 * `expectedName` is what the lossless public copy must be called.
 */
export function sourceAsset(skinId, mode, view) {
  const skin = findSkin(skinId);
  if (skin.isClassic || !isKnownMode(mode) || !isKnownView(view)) return null;
  const name = SOURCE_FILE_PATTERNS[mode][view].replace("{n}", skin.assetPrefix);
  const expectedName = `${name.slice(0, -".png".length)}.${PUBLIC_ASSET_EXTENSION}`;
  return {
    skinId: skin.id,
    assetPrefix: skin.assetPrefix,
    mode,
    view,
    sourceDirectory: SOURCE_DIRECTORIES[mode],
    sourceName: name,
    sourcePath: `${SOURCE_DIRECTORIES[mode]}/${name}`,
    publicUrl: skin.variants[mode].assets[view],
    publicPath: `public/assets/skins/${mode}/${expectedName}`,
    expectedName,
  };
}

export function enumerateSourceAssets() {
  const entries = [];
  for (const skin of SKINS) {
    if (skin.isClassic) continue;
    for (const mode of SKIN_MODES) {
      for (const view of CHARACTER_VIEWS) {
        const entry = sourceAsset(skin.id, mode, view);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

/**
 * Per-image display parameters for a skin/mode/view, or null when there is no
 * artwork (classic). These are measured values, never invented ones.
 */
export function skinDisplayParams(skinId, mode, view) {
  if (!isKnownSkinId(skinId) || !isKnownMode(mode) || !isKnownView(view)) return null;
  const variant = skinVariant(skinId, mode);
  if (!variant?.display) return null;
  return variant.display[view] ?? null;
}

/**
 * The palette a skin currently applies for a mode. `null` means "not specified
 * by the user yet": the page keeps its existing light/dark appearance.
 * A skin's light palette never leaks into its dark palette or into another skin.
 */
export function skinPalette(skinId, mode) {
  const palette = skinVariant(skinId, mode).palette;
  if (palette === null || palette === undefined) return null;
  return palette;
}

/** Only allow-listed token keys are applied; layout keys are rejected. */
export function paletteTokens(skinId, mode) {
  const palette = skinPalette(skinId, mode);
  if (!palette?.tokens) return {};
  const result = {};
  for (const key of PALETTE_TOKEN_KEYS) {
    if (typeof palette.tokens[key] === "string" && palette.tokens[key]) result[key] = palette.tokens[key];
  }
  return result;
}

/** Charts keep their existing series colours unless the user supplies theirs. */
export function paletteChartSeries(skinId, mode) {
  const palette = skinPalette(skinId, mode);
  const series = palette?.chartSeries;
  return Array.isArray(series) && series.length ? series.slice() : null;
}

/**
 * Swatch descriptors for the comparison cards. Values come from the palette (or
 * the mode's existing base when unspecified); the card never invents a colour.
 */
export function paletteSwatches(skinId, mode) {
  const palette = skinPalette(skinId, mode);
  const keys =
    Array.isArray(palette?.swatchKeys) && palette.swatchKeys.length
      ? palette.swatchKeys
      : PALETTE_TOKEN_KEYS.slice(0, 6);
  const tokens = paletteTokens(skinId, mode);
  return keys.map((key) => ({
    key,
    value: tokens[key] ?? null,
    pending: tokens[key] === undefined || tokens[key] === null,
  }));
}

/** True when the skin has no user colours at all for this mode. */
export function isPalettePending(skinId, mode) {
  const palette = skinPalette(skinId, mode);
  if (!palette) return true;
  return Object.keys(paletteTokens(skinId, mode)).length === 0 && !paletteChartSeries(skinId, mode);
}

// ---------------------------------------------------------------------------
// Whole-page palette wiring (plan: 用户真实配色联动)
//
// The user's palette tokens are the single source of colour truth. These pure
// helpers derive the concrete CSS custom properties the interface consumes, so
// the runtime (skin-ui.js apply), the generated pre-paint bootstrap (via
// scripts/prepare-skin-assets.mjs) and the tests share ONE derivation and the
// page, the offline snapshot and the first painted frame can never disagree.
//
// Geometry safety is structural: every derived value is a colour, and the
// neumorphic/ceramic shadow recipes stay in the stylesheet referencing the
// ceramic custom properties, so no declaration here can move a single box.
//
// Only ROOT-CAUSE variables are set. `--panel`, `--track` and `--shadow` follow
// through the stylesheet's own indirections (var(--neo-surface),
// var(--ceramic-well), var(--neo-raised)), keeping the cascade's existing
// structure intact. `--control` is set explicitly because the palette carries a
// dedicated `controlBackground` token the user may tune apart from the panel.
// ---------------------------------------------------------------------------

/**
 * The exact custom properties the wiring may write. Any variable not listed
 * here is never touched, and this list is what apply() removes on classic, so
 * a previous skin's colours can never survive a switch.
 */
export const PALETTE_CSS_VAR_NAMES = Object.freeze([
  "--bg",
  "--neo-surface",
  "--control",
  "--neo-edge",
  "--line",
  "--chart-line",
  "--ink",
  "--muted",
  "--chart-text",
  "--control-hover",
  "--blue",
  "--record",
  "--skin-active-accent",
  "--active-ink",
  "--ceramic-top",
  "--ceramic-bottom",
  "--ceramic-well",
  "--ceramic-light",
  "--ceramic-shade",
  "--ceramic-rim",
]);

/** Parse a hex or rgb()/rgba() colour into { rgb, alpha }; null when unparseable. */
function parsePaletteColour(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length <= 4) hex = [...hex].map((ch) => ch + ch).join("");
    return {
      rgb: [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)),
      alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map((part) => {
      const number = Number.parseFloat(part);
      if (!Number.isFinite(number)) return NaN;
      return Math.min(255, Math.max(0, Math.round(number * (part.includes("%") ? 2.55 : 1))));
    });
    if (rgb.some((channel) => !Number.isFinite(channel))) return null;
    const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    return { rgb, alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1 };
  }
  return null;
}

function paletteRgbToHex(rgb) {
  return `#${rgb
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Linear mix of a toward b by t; null when either side is unparseable. */
function mixPaletteColours(a, b, t) {
  const ca = parsePaletteColour(a);
  const cb = parsePaletteColour(b);
  if (!ca || !cb) return null;
  return paletteRgbToHex(ca.rgb.map((channel, i) => channel + (cb.rgb[i] - channel) * t));
}

/** Same hue as `value` with the given alpha; null when unparseable. */
function paletteColourWithAlpha(value, alpha) {
  const parsed = parsePaletteColour(value);
  if (!parsed) return null;
  return `rgba(${parsed.rgb.join(", ")}, ${alpha})`;
}

function paletteRelativeLuminance(rgb) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function paletteContrastRatio(a, b) {
  const ca = parsePaletteColour(a);
  const cb = parsePaletteColour(b);
  if (!ca || !cb) return null;
  const la = paletteRelativeLuminance(ca.rgb);
  const lb = paletteRelativeLuminance(cb.rgb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour with the better contrast against the accent, for text-on-accent. */
function paletteActiveInkFor(accent) {
  if (!accent) return null;
  const dark = "#10151a";
  const light = "#ffffff";
  return (paletteContrastRatio(dark, accent) ?? 0) >= (paletteContrastRatio(light, accent) ?? 0) ? dark : light;
}

/**
 * Derive the inline custom-property declarations for one mode from the user's
 * tokens. Pure: same input, same output, no DOM. Unparseable or missing tokens
 * simply drop their dependent declarations; the stylesheet defaults keep
 * serving those roles (and apply() removes stale variables before setting).
 */
function derivePaletteDeclarations(tokens, mode) {
  const declarations = [];
  const put = (name, value) => {
    if (value) declarations.push([name, value]);
  };
  const pageBackground = tokens.pageBackground ?? null;
  const panelBackground = tokens.panelBackground ?? null;
  const panelBorder = tokens.panelBorder ?? null;
  const panelHighlight = tokens.panelHighlight ?? null;
  const panelShadow = tokens.panelShadow ?? null;
  const textPrimary = tokens.textPrimary ?? null;
  const accent = tokens.accent ?? null;

  put("--bg", pageBackground);
  put("--neo-surface", panelBackground);
  // The one token the stylesheet's indirection would swallow: controls may be
  // tuned apart from the panel (grok's tuned-dark controls, for example).
  put("--control", tokens.controlBackground ?? null);
  put("--neo-edge", panelBorder);
  put("--line", panelBorder);
  put("--ink", textPrimary);
  put("--muted", tokens.textSecondary ?? null);
  put("--chart-text", tokens.chartText ?? null);
  // Chart gridlines sit between the surface and the ink on both modes, because
  // textPrimary flips with the mode (dark ink on light pages, and vice versa).
  put("--chart-line", mixPaletteColours(panelBackground, textPrimary, 0.35));
  // Hover darkens a light surface but lightens a dark one; highlight/shadow
  // flip with the mode exactly the same way.
  put(
    "--control-hover",
    mode === "light"
      ? mixPaletteColours(panelBackground, panelShadow, 0.35)
      : mixPaletteColours(panelBackground, panelHighlight, 0.35),
  );
  put("--blue", accent);
  // The final theme cascade deliberately pins --record to the accent blue;
  // keeping them equal preserves that single-accent design per skin.
  put("--record", accent);
  put("--skin-active-accent", accent);
  put("--active-ink", paletteActiveInkFor(accent));

  if (mode === "light") {
    put("--ceramic-top", mixPaletteColours(panelBackground, panelHighlight, 0.35));
    put("--ceramic-bottom", mixPaletteColours(panelBackground, pageBackground, 0.55));
    put("--ceramic-well", mixPaletteColours(pageBackground, panelShadow, 0.22));
    put("--ceramic-light", paletteColourWithAlpha(panelHighlight, 0.6));
    put("--ceramic-shade", paletteColourWithAlpha(panelShadow, 0.54));
    put("--ceramic-rim", paletteColourWithAlpha(panelHighlight, 0.6));
  } else {
    put("--ceramic-top", mixPaletteColours(panelBackground, panelHighlight, 0.4));
    put("--ceramic-bottom", mixPaletteColours(panelBackground, panelShadow, 0.35));
    put("--ceramic-well", mixPaletteColours(pageBackground, panelBackground, 0.55));
    put("--ceramic-light", paletteColourWithAlpha(panelHighlight, 0.4));
    put("--ceramic-shade", paletteColourWithAlpha(panelShadow, 0.72));
    put("--ceramic-rim", paletteColourWithAlpha(panelHighlight, 0.4));
  }
  return declarations;
}

/**
 * The inline declarations for one skin/mode, or null when there is nothing to
 * apply (classic, unknown id, or a palette without usable colour tokens).
 * Frozen: the runtime and the generated bootstrap must never mutate them.
 */
export function paletteDeclarations(skinId, mode) {
  if (!isKnownSkinId(skinId) || !isKnownMode(mode)) return null;
  const skin = findSkin(skinId);
  if (!skin || skin.isClassic) return null;
  const tokens = paletteTokens(skinId, mode);
  if (!Object.keys(tokens).length) return null;
  return deepFreeze(derivePaletteDeclarations(tokens, mode).map((pair) => deepFreeze(pair)));
}
