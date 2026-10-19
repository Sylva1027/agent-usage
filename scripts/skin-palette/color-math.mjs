/**
 * Pure colour mathematics for the palette pipeline (implementation plan M1.3).
 *
 * Units and conventions (fixed across solver, checks and review):
 *   - sRGB channels are gamma-encoded values in [0, 1]; OKLab L/a/b use the
 *     author's published units, so L and C are NOT scaled by 100.
 *   - Hue is degrees normalised to [0, 360). At (near-)zero chroma the
 *     convention is H = 0 — atan2 would otherwise flip between 0 and 180 on
 *     the sign of zero and must never surface as NaN.
 *   - The OKLab matrices are Björn Ottosson's published definition
 *     (https://bottosson.github.io/posts/oklab/); the transfer functions and
 *     WCAG luminance follow CSS Color 4 (https://www.w3.org/TR/css-color-4/),
 *     with the contrast threshold read against
 *     https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html.
 *   - Hex output is rounded exactly once; solver and review always consume the
 *     rounded colour. `srgbToHex` refuses clearly out-of-gamut input so
 *     callers cannot bypass gamut fitting.
 *   - `okDistance` (100× OKLab Euclidean) is an internal diagnostic, not a
 *     second WCAG pass/fail standard.
 *
 * Purity: no imports, no filesystem, no DOM, no randomness, no production
 * palette access; every non-finite or malformed input throws. The legacy
 * luminance code in public/skins.js is intentionally left untouched.
 */

/** Tolerance for "this value sits on the sRGB boundary" (policy srgbGamutEpsilon). */
export const SRGB_GAMUT_EPSILON = 1e-7;

/**
 * Chroma at or below this counts as zero: H is pinned to 0 by convention.
 * The float noise floor of a decoded grey sits around 2e-8, so the threshold
 * shares the order of the gamut tolerance — real pipeline chroma is far above.
 */
export const ZERO_CHROMA_EPSILON = 1e-7;

function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数值（收到 ${String(value)}）`);
  }
  return value;
}

function assertRgb(rgb, name) {
  if (!Array.isArray(rgb) || rgb.length !== 3) {
    throw new TypeError(`${name} 必须是 [r, g, b] 三通道数组`);
  }
  for (const channel of rgb) assertFiniteNumber(channel, `${name} 通道`);
  for (const channel of rgb) {
    if (channel < 0 || channel > 1) {
      throw new RangeError(`${name} 通道必须落在 [0, 1]（收到 ${rgb.join(", ")}）`);
    }
  }
  return [rgb[0], rgb[1], rgb[2]];
}

function assertLab(lab, name) {
  if (!lab || typeof lab !== "object") throw new TypeError(`${name} 必须是 { L, a, b } 对象`);
  return {
    L: assertFiniteNumber(lab.L, `${name}.L`),
    a: assertFiniteNumber(lab.a, `${name}.a`),
    b: assertFiniteNumber(lab.b, `${name}.b`),
  };
}

/** Hex string or encoded sRGB triple → triple; contrast/composite accept both. */
function resolveSrgb(value, name) {
  if (typeof value === "string") return hexToSrgb(value);
  return assertRgb(value, name);
}

/** CSS Color 4 sRGB transfer, encoded → linear (0.04045 branch). */
function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** CSS Color 4 sRGB transfer, linear → encoded (standard inverse). */
function srgbChannelFromLinear(channel) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** "#RRGGBB" / "#RGB" (case-insensitive, "#" optional) → encoded [r, g, b] in 0..1. */
export function hexToSrgb(hex) {
  if (typeof hex !== "string") {
    throw new TypeError(`hexToSrgb: 需要十六进制字符串（收到 ${String(hex)}）`);
  }
  const body = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = body.length === 3 ? [...body].map((char) => char + char).join("") : body;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new TypeError(`hexToSrgb: 无法解析 "${hex}"（需要 #RRGGBB 或 #RGB）`);
  }
  return [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16) / 255);
}

/**
 * Encoded sRGB triple → "#RRGGBB" (uppercase). Channels outside the gamut by
 * more than SRGB_GAMUT_EPSILON throw; within the tolerance they count as
 * boundary-converged and are clamped before the single rounding step.
 */
export function srgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) {
    throw new TypeError("srgbToHex: 需要 [r, g, b] 三通道数组");
  }
  for (const channel of rgb) {
    assertFiniteNumber(channel, "srgbToHex 通道");
    if (channel < -SRGB_GAMUT_EPSILON || channel > 1 + SRGB_GAMUT_EPSILON) {
      throw new RangeError(
        `srgbToHex: 通道 ${channel} 超出 sRGB 色域（容忍 ${SRGB_GAMUT_EPSILON}）——先经 fitSrgbGamut 处理`,
      );
    }
  }
  return `#${rgb
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Encoded sRGB triple → OKLab { L, a, b } (author units, L/C not scaled). */
export function srgbToOklab(rgb) {
  const [r, g, b] = assertRgb(rgb, "srgbToOklab 输入");
  const [lr, lg, lb] = [r, g, b].map(srgbChannelToLinear);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * OKLab { L, a, b } → encoded sRGB triple. May return out-of-gamut channels
 * on purpose (callers judge with isInSrgbGamut and fit via fitSrgbGamut).
 */
export function oklabToSrgb(lab) {
  const { L, a, b } = assertLab(lab, "oklabToSrgb 输入");
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(srgbChannelFromLinear);
}

/** OKLab → OKLCH { L, C, H }; H in [0, 360), H = 0 at (near-)zero chroma. */
export function oklabToOklch(lab) {
  const { L, a, b } = assertLab(lab, "oklabToOklch 输入");
  const C = Math.hypot(a, b);
  if (C <= ZERO_CHROMA_EPSILON) return { L, C, H: 0 };
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

/** OKLCH { L, C, H } → OKLab { L, a, b }; any finite H is accepted. */
export function oklchToOklab(lch) {
  if (!lch || typeof lch !== "object") throw new TypeError("oklchToOklab 输入必须是 { L, C, H } 对象");
  const L = assertFiniteNumber(lch.L, "oklchToOklab 输入.L");
  const C = assertFiniteNumber(lch.C, "oklchToOklab 输入.C");
  const H = assertFiniteNumber(lch.H, "oklchToOklab 输入.H");
  if (C < 0) throw new RangeError("oklchToOklab 输入.C 不能为负");
  // 先归一化再乘 π：极大的有限 H（如 Number.MAX_VALUE）直接乘会溢出为
  // Infinity，cos/sin 随即产生 NaN——归一化后角度有界，任何有限 H 都安全。
  const hue = ((H % 360) + 360) % 360;
  const radians = (hue * Math.PI) / 180;
  return { L, a: C * Math.cos(radians), b: C * Math.sin(radians) };
}

/** True when every channel sits inside [0, 1] within SRGB_GAMUT_EPSILON. */
export function isInSrgbGamut(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) {
    throw new TypeError("isInSrgbGamut: 需要 [r, g, b] 三通道数组");
  }
  // 逐通道检查：Array.prototype.every 会跳过稀疏空位，[0, , 0] 会被误判在域内。
  for (let index = 0; index < 3; index += 1) {
    const channel = assertFiniteNumber(rgb[index], `isInSrgbGamut 通道 ${index}`);
    if (channel < -SRGB_GAMUT_EPSILON || channel > 1 + SRGB_GAMUT_EPSILON) return false;
  }
  return true;
}

/**
 * Fit an OKLCH colour into sRGB by keeping L/H and bisecting C within
 * [0, input C] (at most 24 steps, which beats the 1e-7 judgement tolerance).
 * In-gamut input passes through unchanged (chromaReduced: false). Only
 * convergence within the numerical tolerance may sit on the 0/1 boundary —
 * clearly out-of-gamut channels are never clamped into "unchanged" claims.
 */
export function fitSrgbGamut(lch) {
  if (!lch || typeof lch !== "object") throw new TypeError("fitSrgbGamut 输入必须是 { L, C, H } 对象");
  const L = assertFiniteNumber(lch.L, "fitSrgbGamut 输入.L");
  const C = assertFiniteNumber(lch.C, "fitSrgbGamut 输入.C");
  const H = assertFiniteNumber(lch.H, "fitSrgbGamut 输入.H");
  if (L < 0 || L > 1) throw new RangeError("fitSrgbGamut 输入.L 必须落在 [0, 1]");
  if (C < 0) throw new RangeError("fitSrgbGamut 输入.C 不能为负");
  const hue = ((H % 360) + 360) % 360;
  const lchToSrgb = (chroma) => oklabToSrgb(oklchToOklab({ L, C: chroma, H: hue }));
  const direct = lchToSrgb(C);
  if (isInSrgbGamut(direct)) {
    return { rgb: direct, lch: { L, C, H: hue }, chromaReduced: false };
  }
  let low = 0;
  let high = C;
  for (let iteration = 0; iteration < 24 && high - low > SRGB_GAMUT_EPSILON; iteration += 1) {
    const mid = (low + high) / 2;
    if (isInSrgbGamut(lchToSrgb(mid))) low = mid;
    else high = mid;
  }
  const rgb = lchToSrgb(low);
  if (!isInSrgbGamut(rgb)) {
    throw new Error(`fitSrgbGamut: 二分未收敛（L=${L}, H=${hue}）——请上报此输入`);
  }
  return { rgb, lch: { L, C: low, H: hue }, chromaReduced: true };
}

/**
 * CSS simple alpha compositing on the ENCODED sRGB channels — exactly what a
 * browser computes for rgba() over a background. The effective colour is the
 * result; luminance is derived from it afterwards, never by interpolating
 * luminances (that ordering is why this helper exists).
 */
export function compositeSrgb(foreground, alpha, background) {
  assertFiniteNumber(alpha, "compositeSrgb alpha");
  if (alpha < 0 || alpha > 1) throw new RangeError("compositeSrgb alpha 必须落在 [0, 1]");
  const front = resolveSrgb(foreground, "compositeSrgb foreground");
  const back = resolveSrgb(background, "compositeSrgb background");
  return front.map((channel, index) => channel * alpha + back[index] * (1 - alpha));
}

/** WCAG relative luminance (0.2126 / 0.7152 / 0.0722) of an encoded triple. */
export function relativeLuminance(rgb) {
  const [r, g, b] = assertRgb(rgb, "relativeLuminance 输入");
  const [lr, lg, lb] = [r, g, b].map(srgbChannelToLinear);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio ≥ 1; accepts hex strings or encoded triples. */
export function contrastRatio(a, b) {
  const first = relativeLuminance(resolveSrgb(a, "contrastRatio 输入 a"));
  const second = relativeLuminance(resolveSrgb(b, "contrastRatio 输入 b"));
  const [hi, lo] = first >= second ? [first, second] : [second, first];
  return (hi + 0.05) / (lo + 0.05);
}

/** 100× Euclidean distance in OKLab — internal diagnostic, not a WCAG gate. */
export function okDistance(a, b) {
  const first = assertLab(a, "okDistance 输入 a");
  const second = assertLab(b, "okDistance 输入 b");
  const dL = first.L - second.L;
  const da = first.a - second.a;
  const db = first.b - second.b;
  return Math.sqrt(dL * dL + da * da + db * db) * 100;
}
