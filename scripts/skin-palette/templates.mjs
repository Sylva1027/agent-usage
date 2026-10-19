/**
 * M2.1 固定表面模板与三种变体（纯函数，零文件/DOM/随机访问）。
 *
 * 从配方（M5 拥有的 profiles 条目）读取 identityHex / surfaceH / surfaceC /
 * pageL.light / pageL.dark / accentC 六个字段，按任务卡固定的第一版表面模板
 * 构造 light/dark 两模式的表面 token：先构造 OKLCH，再经 M1.3 fitSrgbGamut
 * 色域处理与 srgbToHex 单次舍入序列化（大写 #RRGGBB，与候选契约一致）。
 *
 * - L 计算结束钳制到 [0.04, 0.998]（含链式计算：panelL 取钳制后的面板亮度）。
 * - 表面 C（变体缩放后）钳制到 [0, 0.045]；H 一律取配方 surfaceH。
 * - 变体固定 a「基准」/ b「轻染」/ c「浓染」，不发明第四种。
 * - 背景修正按固定顺序枚举（light: 0/+0.020/−0.020；dark: 0/−0.020/+0.020），
 *   最终 pageL 偏移相对配方基值不超过 ±0.04（越界钳制），钳制后有效的重复
 *   修正组去除（保持先出现者）。
 * - 前景只给起点、允许 L 范围与 H/C 约束（由 M2.2 求解填写），本模块不求解；
 *   stage 固定 "draft"，候选在求解完成前不得对外宣称通过。
 * - gamut 修正记录逐 token 保留（chromaReduced / 请求与最终 L/C），供 M3 诊断。
 */

import { fitSrgbGamut, hexToSrgb, oklabToOklch, srgbToHex, srgbToOklab } from "./color-math.mjs";

export const TEMPLATE_STAGE = "draft";
/** L 计算结束限制（任务卡固定）。 */
export const L_LIMITS = Object.freeze({ min: 0.04, max: 0.998 });
/** 表面 C 限制（变体缩放后钳制）。 */
export const SURFACE_C_LIMIT = Object.freeze({ min: 0, max: 0.045 });
/** pageL 最终偏移相对配方基值的上下限。 */
export const PAGE_L_OFFSET_LIMIT = 0.04;
/** accent 色度向下搜索的下限（M2.2 使用，模板只随变体记录）。 */
export const ACCENT_MIN_C = 0.035;
/** 文字色度上限的绝对值上限（与表面 C 取小）。 */
export const TEXT_C_ABS_LIMIT = 0.018;

export const VARIANT_IDS = Object.freeze(["a", "b", "c"]);

const VARIANTS = Object.freeze({
  a: Object.freeze({
    id: "a",
    label: "基准",
    surfaceK: 1,
    accentK: 1,
    pageLOffset: Object.freeze({ light: 0, dark: 0 }),
  }),
  b: Object.freeze({
    id: "b",
    label: "轻染",
    surfaceK: 0.75,
    accentK: 0.9,
    pageLOffset: Object.freeze({ light: 0.015, dark: -0.025 }),
  }),
  c: Object.freeze({
    id: "c",
    label: "浓染",
    surfaceK: 1.2,
    accentK: 1.05,
    pageLOffset: Object.freeze({ light: -0.015, dark: 0.015 }),
  }),
});

/** 背景修正枚举顺序固定：light 0/+0.020/−0.020，dark 0/−0.020/+0.020。 */
const CORRECTION_ORDER = Object.freeze({
  light: Object.freeze([0, 0.02, -0.02]),
  dark: Object.freeze([0, -0.02, 0.02]),
});

/** 面板系相对偏移（任务卡表面模板表）。 */
const SURFACE_DELTAS = Object.freeze({
  light: Object.freeze({ panel: 0.03, highlight: 0.025, shadow: -0.16, border: -0.045 }),
  dark: Object.freeze({ panel: 0.045, highlight: 0.08, shadow: -0.12, border: 0.04 }),
});

/** 前景起点与允许 L 范围（任务卡前景表；H/C 由变体提供）。 */
const FOREGROUND_SPECS = Object.freeze({
  light: Object.freeze({
    textPrimary: Object.freeze({ startL: 0.24, lMin: 0.1, lMax: 0.48 }),
    // .58 opacity adjacent-month text needs a deeper source color to reach the existing 4.7 target.
    textSecondary: Object.freeze({ startL: 0.43, lMin: 0.12, lMax: 0.6 }),
    chartText: Object.freeze({ startL: 0.43, lMin: 0.18, lMax: 0.6 }),
    accent: Object.freeze({ startL: 0.55, lMin: 0.28, lMax: 0.68 }),
  }),
  dark: Object.freeze({
    textPrimary: Object.freeze({ startL: 0.95, lMin: 0.78, lMax: 0.99 }),
    textSecondary: Object.freeze({ startL: 0.78, lMin: 0.62, lMax: 0.99 }),
    chartText: Object.freeze({ startL: 0.78, lMin: 0.62, lMax: 0.99 }),
    accent: Object.freeze({ startL: 0.78, lMin: 0.62, lMax: 0.94 }),
  }),
});

const MODES = Object.freeze(["light", "dark"]);

function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数值（收到 ${String(value)}）`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 浮点稳定的去重键：1e-9 粒度，避免 0.02+0.02 与 0.04 字面量的表示差。 */
function dedupeKey(value) {
  return Math.round(value * 1e9) / 1e9;
}

function normalizeHue(degrees) {
  return ((degrees % 360) + 360) % 360;
}

/**
 * 校验并归一化配方：只读任务卡固定的六个字段，未知字段忽略（profileSnapshot
 * 由 M2.3 负责完整保存）。identityHex 交给 M1.3 hexToSrgb 校验可解析性。
 */
function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("profile 必须是配方对象");
  }
  if (typeof profile.identityHex !== "string") {
    throw new TypeError("profile.identityHex 必须是十六进制字符串");
  }
  hexToSrgb(profile.identityHex);
  assertFiniteNumber(profile.surfaceH, "profile.surfaceH");
  assertFiniteNumber(profile.surfaceC, "profile.surfaceC");
  assertFiniteNumber(profile.accentC, "profile.accentC");
  if (!profile.pageL || typeof profile.pageL !== "object" || Array.isArray(profile.pageL)) {
    throw new TypeError("profile.pageL 必须是 { light, dark } 对象");
  }
  assertFiniteNumber(profile.pageL.light, "profile.pageL.light");
  assertFiniteNumber(profile.pageL.dark, "profile.pageL.dark");
  return {
    identityHex: profile.identityHex,
    surfaceH: normalizeHue(profile.surfaceH),
    surfaceC: profile.surfaceC,
    pageL: { light: profile.pageL.light, dark: profile.pageL.dark },
    accentC: profile.accentC,
  };
}

/** OKLCH → 色域处理 → 大写 HEX；gamut 记录逐 token 保留。 */
function buildSurfaceToken(requestedL, requestedC, hue) {
  const finalL = clamp(requestedL, L_LIMITS.min, L_LIMITS.max);
  const fitted = fitSrgbGamut({ L: finalL, C: requestedC, H: hue });
  return {
    hex: srgbToHex(fitted.rgb),
    record: {
      chromaReduced: fitted.chromaReduced,
      requestedL,
      requestedC,
      finalL: fitted.lch.L,
      finalC: fitted.lch.C,
    },
  };
}

/** 单个修正组的六个表面 token（任务卡表面模板表；controlBackground 同面板底）。 */
function buildBackgrounds(mode, pageL, surfaceC, hue) {
  const deltas = SURFACE_DELTAS[mode];
  const panelL = clamp(pageL + deltas.panel, L_LIMITS.min, L_LIMITS.max);
  const tokens = {};
  const gamut = {};
  const put = (name, requestedL, requestedC) => {
    const built = buildSurfaceToken(requestedL, requestedC, hue);
    tokens[name] = built.hex;
    gamut[name] = built.record;
  };
  put("pageBackground", pageL, surfaceC);
  put("panelBackground", panelL, 0.6 * surfaceC);
  put("panelHighlight", panelL + deltas.highlight, 0.25 * surfaceC);
  put("panelShadow", pageL + deltas.shadow, 0.75 * surfaceC);
  put("panelBorder", panelL + deltas.border, 0.4 * surfaceC);
  tokens.controlBackground = tokens.panelBackground;
  gamut.controlBackground = gamut.panelBackground;
  return { tokens, gamut };
}

/**
 * 一个变体一个模式的背景修正组：按固定顺序枚举，pageL 最终偏移钳制到
 * 配方基值 ±0.04，token L 计算结束钳制到 [0.04, 0.998]；钳制后 pageL 相同的
 * 重复修正组去除（保持先出现者，不重排）。
 */
function buildCorrections(variant, mode, profile, surfaceC, hue) {
  const base = profile.pageL[mode];
  const groups = [];
  const seen = new Set();
  for (const correction of CORRECTION_ORDER[mode]) {
    const requestedPageLOffset = variant.pageLOffset[mode] + correction;
    const pageLOffset = clamp(requestedPageLOffset, -PAGE_L_OFFSET_LIMIT, PAGE_L_OFFSET_LIMIT);
    const requestedPageL = base + pageLOffset;
    const pageL = clamp(requestedPageL, L_LIMITS.min, L_LIMITS.max);
    const key = dedupeKey(pageL);
    if (seen.has(key)) continue;
    seen.add(key);
    const { tokens, gamut } = buildBackgrounds(mode, pageL, surfaceC, hue);
    groups.push({
      index: groups.length,
      requestedPageLOffset,
      pageLOffset,
      offsetClamped: pageLOffset !== requestedPageLOffset,
      pageL,
      lClamped: pageL !== requestedPageL,
      backgrounds: tokens,
      gamut,
    });
  }
  return groups;
}

/** 前景起点/范围/H/C 约束（M2.2 求解的搜索契约，本模块不求解）。 */
function buildForegrounds(mode, surfaceC, surfaceHue, accentHue, accentTargetC) {
  const specs = FOREGROUND_SPECS[mode];
  const textHue = surfaceHue;
  const textMaxC = Math.min(surfaceC, TEXT_C_ABS_LIMIT);
  return {
    textPrimary: { ...specs.textPrimary, hue: textHue, maxC: textMaxC },
    textSecondary: { ...specs.textSecondary, hue: textHue, maxC: textMaxC },
    chartText: { ...specs.chartText, hue: textHue, maxC: textMaxC },
    accent: { ...specs.accent, hue: accentHue, cTarget: accentTargetC, minC: ACCENT_MIN_C },
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 纯函数：配方 → a/b/c 三变体 × light/dark 的完整模式模板（草案）。
 * 同一配方重复调用输出深度相等；输出深度冻结。
 */
export function buildSurfaceTemplates(profile) {
  const normalized = normalizeProfile(profile);
  const accentHue = oklabToOklch(srgbToOklab(hexToSrgb(normalized.identityHex))).H;
  const variants = {};
  for (const id of VARIANT_IDS) {
    const variant = VARIANTS[id];
    const surfaceC = clamp(normalized.surfaceC * variant.surfaceK, SURFACE_C_LIMIT.min, SURFACE_C_LIMIT.max);
    const accentC = normalized.accentC * variant.accentK;
    const modes = {};
    for (const mode of MODES) {
      modes[mode] = {
        foregrounds: buildForegrounds(mode, surfaceC, normalized.surfaceH, accentHue, accentC),
        corrections: buildCorrections(variant, mode, normalized, surfaceC, normalized.surfaceH),
      };
    }
    variants[id] = {
      id,
      label: variant.label,
      surfaceC,
      // clamp 对界内值原样返回，故严格不等 = 值确被钳制；不能用去重量化键判定——
      // 幅度小于键粒度（1e-9）的越界会漏报。去重键只用于 pageL 分组。
      surfaceCClamped: surfaceC !== normalized.surfaceC * variant.surfaceK,
      accentC,
      pageLOffset: { light: variant.pageLOffset.light, dark: variant.pageLOffset.dark },
      modes,
    };
  }
  return deepFreeze({
    stage: TEMPLATE_STAGE,
    profile: normalized,
    identityHue: accentHue,
    variants,
  });
}
