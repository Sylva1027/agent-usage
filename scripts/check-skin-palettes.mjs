// Validate the user's colour input in public/skin-palettes.js and report exactly
// what is wrong, with line numbers. Read-only: never rewrites the input file.
//
// Usage: node scripts/check-skin-palettes.mjs      (or: npm run skins:palette)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = await import(pathToFileURL(path.join(root, "public/skins.js")).href);
const { PALETTE_TOKEN_KEYS, SKINS } = registry;

const inputPath = path.join(root, "public/skin-palettes.js");
const source = readFileSync(inputPath, "utf8");
const lines = source.split(/\r?\n/);

const { SKIN_PALETTES } = await import(pathToFileURL(inputPath).href);

/** Colour-only acceptance. A unit-bearing or font value is never a colour. */
const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|transparent|currentcolor|inherit|initial|unset|revert)$/i;

/** Keys that would silently change geometry if they ever reached CSS. */
const FORBIDDEN_HINTS = /(px|rem|em|%|vw|vh|pt|ch|deg|ms|s)$/i;

const errors = [];
const warnings = [];
const summary = [];

function lineOf(needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  return index === -1 ? null : index + 1;
}

function where(skinId, mode, token) {
  const skinLine = lineOf(`${skinId}: {`);
  const detail = token ? ` (${mode}.${token})` : ` (${mode})`;
  const found = token ? lineOf(`${token}:`) : null;
  const line = found ?? skinLine;
  return line ? `public/skin-palettes.js:${line}` : `public/skin-palettes.js (${skinId}${detail})`;
}

const knownIds = new Set(SKINS.map((skin) => skin.id));
const allowed = new Set(PALETTE_TOKEN_KEYS);

// 1. The input must only name skins the registry knows.
for (const skinId of Object.keys(SKIN_PALETTES)) {
  if (!knownIds.has(skinId)) {
    errors.push(`${where(skinId, "light")}: unknown skin id "${skinId}". Known ids: ${[...knownIds].join(", ")}`);
  }
}

// 2. classic must not carry a palette at all.
if (Object.hasOwn(SKIN_PALETTES, "classic")) {
  const classic = SKIN_PALETTES.classic;
  if (classic?.light || classic?.dark) {
    errors.push(
      `${where("classic", "light")}: the no-skin option has no colours by definition. Remove the "classic" entry.`,
    );
  }
}

// 3. Per-skin, per-mode validation.
let filledModes = 0;
const filled = [];

for (const skin of SKINS) {
  if (skin.isClassic) continue;
  const entry = SKIN_PALETTES[skin.id];
  if (entry === undefined) {
    warnings.push(`${skin.id}: no entry in SKIN_PALETTES; it will keep the pending state.`);
    continue;
  }
  if (entry === null || typeof entry !== "object") {
    errors.push(`${where(skin.id, "light")}: expected an object with "light" and "dark" keys.`);
    continue;
  }

  const extraKeys = Object.keys(entry).filter((key) => key !== "light" && key !== "dark");
  if (extraKeys.length) {
    errors.push(`${where(skin.id, "light")}: unexpected key(s) ${extraKeys.join(", ")}. Only "light" and "dark".`);
  }

  for (const mode of ["light", "dark"]) {
    const palette = entry[mode];
    if (palette === null || palette === undefined) continue; // pending is a valid state
    if (typeof palette !== "object" || Array.isArray(palette)) {
      errors.push(`${where(skin.id, mode)}: expected an object of colour tokens, or null.`);
      continue;
    }

    const tokens = {};
    let tokenCount = 0;

    for (const [token, value] of Object.entries(palette)) {
      // `chartSeries` is the one array-valued token.
      if (token === "chartSeries") {
        if (!Array.isArray(value) || !value.length) {
          errors.push(`${where(skin.id, mode, token)}: chartSeries must be a non-empty array of colours.`);
          continue;
        }
        const bad = value.filter((colour) => typeof colour !== "string" || !COLOUR.test(colour.trim()));
        if (bad.length) {
          errors.push(`${where(skin.id, mode, token)}: not valid colour(s): ${bad.map(String).join(", ")}`);
          continue;
        }
        tokenCount += 1;
        continue;
      }

      if (!allowed.has(token)) {
        const near = [...allowed].find((key) => key.toLowerCase() === token.toLowerCase());
        errors.push(
          `${where(skin.id, mode, token)}: "${token}" is not an allowed token.` +
            (near ? ` Did you mean "${near}"?` : ` Allowed: ${[...allowed].join(", ")}`) +
            `\n    Note: this channel accepts colours only; layout, spacing and font values are rejected by design.`,
        );
        continue;
      }

      if (typeof value !== "string" || !value.trim()) {
        errors.push(`${where(skin.id, mode, token)}: expected a non-empty colour string, got ${JSON.stringify(value)}.`);
        continue;
      }
      const trimmed = value.trim();
      if (!COLOUR.test(trimmed)) {
        const hint = FORBIDDEN_HINTS.test(trimmed)
          ? " That looks like a size or duration; skin colours must never change layout geometry."
          : "";
        errors.push(`${where(skin.id, mode, token)}: "${trimmed}" is not a valid CSS colour.${hint}`);
        continue;
      }
      tokens[token] = trimmed;
      tokenCount += 1;
    }

    if (tokenCount > 0) {
      filledModes += 1;
      filled.push(`${skin.id}.${mode} (${tokenCount} token${tokenCount === 1 ? "" : "s"})`);
    } else {
      warnings.push(`${skin.id}.${mode}: no tokens filled; it stays "colours pending".`);
    }

    // Contrast sanity: text on panel, when both are supplied as hex.
    if (tokens.textPrimary && (tokens.panelBackground || tokens.pageBackground)) {
      const background = tokens.panelBackground || tokens.pageBackground;
      const ratio = contrastRatio(tokens.textPrimary, background);
      if (ratio !== null && ratio < 3) {
        warnings.push(
          `${skin.id}.${mode}: textPrimary on the panel has contrast ${ratio.toFixed(2)}:1, which is low. ` +
            `Please check readability (WCAG AA body text asks for 4.5:1).`,
        );
      }
    }
    if (tokens.textSecondary && (tokens.panelBackground || tokens.pageBackground)) {
      const ratio = contrastRatio(tokens.textSecondary, tokens.panelBackground || tokens.pageBackground);
      if (ratio !== null && ratio < 3) {
        warnings.push(`${skin.id}.${mode}: textSecondary contrast is ${ratio.toFixed(2)}:1, which is low.`);
      }
    }
  }
}

function hexToRgb(value) {
  const match = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (hex.length === 4) hex = [...hex].map((c) => c + c).join("");
  if (hex.length === 8) hex = hex.slice(0, 6);
  if (hex.length !== 6) return null;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(front, back) {
  const a = hexToRgb(front);
  const b = hexToRgb(back);
  if (!a || !b) return null;
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

for (const warning of warnings) console.log(`warn: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);

if (errors.length) {
  console.error(`\npalette check: FAIL (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  process.exit(1);
}

const total = SKINS.filter((skin) => !skin.isClassic).length * 2;
console.log(
  `\npalette check: PASS (${filledModes}/${total} mode slots filled${
    filled.length ? `: ${filled.join(", ")}` : ""
  }; the rest stay "colours pending")`,
);
