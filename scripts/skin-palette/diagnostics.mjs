/**
 * M3.3 材质、成对身份与最近邻诊断（card: M3-readability-and-difference-checks.md）。
 *
 * 纯函数：只读取**已经生成的真实声明**（候选 token 经 M1.1
 * `derivePaletteDeclarationsFromTokens` 派生出的 CSS 变量值）与已有评审，
 * 不修改 token、不写文件、不导航、不产生任何阅读判定。
 *
 * 三项固定输出：
 *   1. 材质剖面：实际 top/panel/bottom/page/well 的 OKLab L、相邻 D_OK、高光/阴影
 *      alpha。只如实记录层次剖面，不强制所有皮肤满足同一条 L 单调链。
 *   2. 成对身份：light/dark 各自输出 page/panel/accent 的两两距离矩阵，列每个候选
 *      的最近邻**皮肤**及每项距离；成对整体近似值固定为六项距离的算术平均，
 *      命名 `pairMeanDistance`——它只是距离，不得包装成审美总分。
 *   3. 提醒标记：top 与 bottom 的 D_OK < 2.0 标 `flatSurfaceWarning`；不同皮肤六项
 *      都 < 3.0 标 `nearNeighborWarning`。两者只提醒视觉复核，不作为"陶瓷合格"或
 *      "身份错误"的证明；方向性、凹凸与身份仍看原尺寸截图。
 *
 * 硬规则：
 *   - 距离单位统一为 M1.3 `okDistance`（100× OKLab 欧氏距离），不与别尺度混用；
 *   - 缺任何一项 → 对应结果 incomplete（`complete: false` + `missing`），**绝不用 0
 *     补齐**（0 会被读成"完全相同"）；
 *   - 同色相允许共存：不强制色相分隔、不更换"官方色"、不按 gamut 彩度排序；
 *   - 输出不得包含任何 pass/fail/readiness 之类的判定字段——材质或差异数据再高也
 *     翻不动文字失败（该不变量由 `assertDiagnosticsCarryNoVerdict` 自检 + 专项测试
 *     双锁）。
 */

import { MODES } from "./contracts.mjs";
import { okDistance, srgbToHex, srgbToOklab } from "./color-math.mjs";
import { parseDeclaredValue } from "./evaluate.mjs";
import { derivePaletteDeclarationsFromTokens } from "../../public/skins.js";

/**
 * 材质五表面（卡面 top/panel/bottom/page/well）→ M1.1 派生的 CSS 变量。
 * 顺序即层次链：陶瓷抬升面 → 面板体 → 面板底缘 → 页面 → 凹陷槽。
 * 派生公式属 M1.1（与 styles.css 生产规则同源），此处只读结果，不复制公式。
 */
export const MATERIAL_SURFACES = Object.freeze([
  Object.freeze({ name: "top", cssVariable: "--ceramic-top" }),
  Object.freeze({ name: "panel", cssVariable: "--neo-surface" }),
  Object.freeze({ name: "bottom", cssVariable: "--ceramic-bottom" }),
  Object.freeze({ name: "page", cssVariable: "--bg" }),
  Object.freeze({ name: "well", cssVariable: "--ceramic-well" }),
]);

/** 高光/阴影的 alpha 载体（值本身带 alpha，是剖面要记录的对象）。 */
const ALPHA_SURFACES = Object.freeze([
  Object.freeze({ name: "highlight", cssVariable: "--ceramic-light" }),
  Object.freeze({ name: "shadow", cssVariable: "--ceramic-shade" }),
]);

/** 成对身份样本：与 M2.3 去重同口径（浅深 × page/panel/accent 共六项）。 */
export const IDENTITY_SAMPLES = Object.freeze([
  Object.freeze({ name: "page", cssVariable: "--bg", token: "pageBackground" }),
  Object.freeze({ name: "panel", cssVariable: "--neo-surface", token: "panelBackground" }),
  Object.freeze({ name: "accent", cssVariable: "--blue", token: "accent" }),
]);

/**
 * 首版提醒阈值（D_OK，100× OKLab）。卡面规定：调整必须增 policy 版本、重跑报告并
 * 记录理由。阈值归属 M0 的 policy.json，M3.4 接线后应由 policy 提供；在那之前本模块
 * 保持零 I/O 不读文件，只留这一份默认值 + `thresholds` 出入口（M3.4 传入 policy 值、
 * 专项测试用它做边界两侧夹逼）。
 */
export const DIAGNOSTIC_THRESHOLDS = Object.freeze({
  flatSurfaceDOk: 2.0,
  nearNeighborDOk: 3.0,
});

/** 诊断树里不允许出现的键：任何一项都会被读成阅读判定，卡面明令禁止。 */
const VERDICT_KEYS = Object.freeze(
  new Set(["pass", "fail", "ready", "readiness", "rejected", "verdict", "score", "accepted"]),
);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("diagnoseCandidates: candidate 必须是对象");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new TypeError("diagnoseCandidates: candidate.id 必须是非空字符串");
  }
  if (typeof candidate.skinId !== "string" || candidate.skinId.length === 0) {
    throw new TypeError(`diagnoseCandidates: 候选 ${candidate.id} 的 skinId 必须是非空字符串`);
  }
  if (!candidate.modes || typeof candidate.modes !== "object") {
    throw new TypeError(`diagnoseCandidates: 候选 ${candidate.id} 缺少 modes`);
  }
  for (const mode of MODES) {
    if (!candidate.modes[mode] || typeof candidate.modes[mode] !== "object") {
      throw new TypeError(`diagnoseCandidates: 候选 ${candidate.id} 缺少 ${mode} 模式 token`);
    }
  }
  return candidate;
}

function assertThresholds(thresholds) {
  if (thresholds === undefined || thresholds === null) return DIAGNOSTIC_THRESHOLDS;
  const normalized = {};
  for (const key of ["flatSurfaceDOk", "nearNeighborDOk"]) {
    const value = thresholds[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`diagnoseCandidates: thresholds.${key} 必须是有限正数`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

/** 候选 token → 该模式的 M1.1 派生声明表；派生不出任何声明时返回 null。 */
function declarationMapOf(tokens, mode) {
  const declarations = derivePaletteDeclarationsFromTokens(tokens, mode);
  if (!declarations) return null;
  const map = new Map();
  for (const [name, value] of declarations) map.set(name, value);
  return map;
}

/** 读一个声明色 → { value, hex, alpha, okLab }；缺失或解析不了 → null。 */
function readDeclaredColor(map, cssVariable) {
  const value = map ? (map.get(cssVariable) ?? null) : null;
  if (value === null) return null;
  const parsed = parseDeclaredValue(value);
  if (!parsed) return null;
  return { value, hex: srgbToHex(parsed.rgb), alpha: parsed.alpha, okLab: srgbToOklab(parsed.rgb) };
}

function distanceOf(left, right) {
  if (!left || !right) return null;
  return okDistance(left.okLab, right.okLab);
}

/** 单个模式的材质剖面：五表面 L 链 + 相邻 D_OK + 高光/阴影 alpha + 平坡提醒。 */
function materialProfile(tokens, mode, thresholds) {
  const map = declarationMapOf(tokens, mode);
  const read = new Map();
  const surfaces = [];
  const missing = [];
  for (const { name, cssVariable } of MATERIAL_SURFACES) {
    const color = readDeclaredColor(map, cssVariable);
    read.set(name, color);
    if (!color) missing.push(cssVariable);
    surfaces.push({
      name,
      cssVariable,
      value: color ? color.value : map ? (map.get(cssVariable) ?? null) : null,
      hex: color ? color.hex : null,
      alpha: color ? color.alpha : null,
      okL: color ? color.okLab.L : null,
    });
  }
  const adjacent = [];
  for (let index = 1; index < MATERIAL_SURFACES.length; index += 1) {
    const from = MATERIAL_SURFACES[index - 1];
    const to = MATERIAL_SURFACES[index];
    const dOk = distanceOf(read.get(from.name), read.get(to.name));
    if (dOk === null) missing.push(`${from.name}→${to.name} 相邻距离（${from.cssVariable} / ${to.cssVariable}）`);
    adjacent.push({ from: from.name, to: to.name, dOk });
  }
  // 平坡只看 top 与 bottom 这一对（卡面点名的两项），不推广成"整条链必须单调"
  const topToBottom = distanceOf(read.get("top"), read.get("bottom"));
  const alphas = {};
  for (const { name, cssVariable } of ALPHA_SURFACES) {
    const color = readDeclaredColor(map, cssVariable);
    if (!color) missing.push(cssVariable);
    alphas[name] = {
      cssVariable,
      value: color ? color.value : null,
      hex: color ? color.hex : null,
      alpha: color ? color.alpha : null,
    };
  }
  return {
    surfaces,
    adjacent,
    topToBottomDOk: topToBottom,
    flatSurfaceWarning: topToBottom !== null && topToBottom < thresholds.flatSurfaceDOk,
    highlight: alphas.highlight,
    shadow: alphas.shadow,
    complete: missing.length === 0,
    missing,
  };
}

/**
 * 单个候选的材质剖面（两个模式）。`flatSurfaceWarnings` 列出触发平坡提醒的模式，
 * 它只提醒视觉复核，不是"陶瓷合格"证明。
 */
export function diagnoseMaterial({ candidate, thresholds } = {}) {
  assertCandidate(candidate);
  const limits = assertThresholds(thresholds);
  const modes = {};
  for (const mode of MODES) {
    modes[mode] = materialProfile(candidate.modes[mode], mode, limits);
  }
  return deepFreeze({
    candidateId: candidate.id,
    skinId: candidate.skinId,
    variant: typeof candidate.variant === "string" ? candidate.variant : null,
    modes,
    flatSurfaceWarnings: MODES.filter((mode) => modes[mode].flatSurfaceWarning),
  });
}

/** 单个候选单个模式的三个身份样本；缺失项进 missing，绝不用 0 补。 */
function identitySamples(tokens, mode) {
  const map = declarationMapOf(tokens, mode);
  const samples = {};
  const missing = [];
  for (const { name, cssVariable } of IDENTITY_SAMPLES) {
    const color = readDeclaredColor(map, cssVariable);
    if (!color) {
      missing.push(cssVariable);
      samples[name] = null;
      continue;
    }
    samples[name] = { cssVariable, hex: color.hex, okLab: color.okLab };
  }
  return { samples, missing };
}

function assertCandidates(candidates, label) {
  if (!Array.isArray(candidates)) {
    throw new TypeError(`${label}: candidates 必须是数组`);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    assertCandidate(candidate);
    if (seen.has(candidate.id)) {
      throw new TypeError(`${label}: 候选 id 重复（${candidate.id}）`);
    }
    seen.add(candidate.id);
  }
  return candidates;
}

/**
 * 成对身份诊断：两两距离矩阵（每模式一张）+ 六项距离与 `pairMeanDistance` +
 * 每个候选的最近邻皮肤。只在不同皮肤之间算最近邻与 `nearNeighborWarning`
 * （同皮肤的 a/b/c 变体本就应该像）。
 */
export function diagnoseIdentity({ candidates, thresholds } = {}) {
  assertCandidates(candidates, "diagnoseIdentity");
  const limits = assertThresholds(thresholds);

  const entries = candidates.map((candidate) => {
    const modes = {};
    for (const mode of MODES) modes[mode] = identitySamples(candidate.modes[mode], mode);
    return { candidate, modes };
  });

  // 每模式一张两两矩阵（上三角，按输入序）：样本不全的距离记 null 并列出缺项
  const matrix = {};
  for (const mode of MODES) {
    const cells = [];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const a = entries[left];
        const b = entries[right];
        const distances = {};
        const missing = [];
        for (const { name, cssVariable } of IDENTITY_SAMPLES) {
          const first = a.modes[mode].samples[name];
          const second = b.modes[mode].samples[name];
          if (!first || !second) {
            distances[name] = null;
            missing.push(cssVariable);
            continue;
          }
          distances[name] = okDistance(first.okLab, second.okLab);
        }
        cells.push({
          left: a.candidate.id,
          right: b.candidate.id,
          distances,
          complete: missing.length === 0,
          missing,
        });
      }
    }
    matrix[mode] = cells;
  }

  // 六项距离（浅深 × page/panel/accent）+ 成对整体近似值（算术平均）
  const pairs = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left];
      const b = entries[right];
      const distances = [];
      const missing = [];
      for (const mode of MODES) {
        for (const { name, cssVariable } of IDENTITY_SAMPLES) {
          const first = a.modes[mode].samples[name];
          const second = b.modes[mode].samples[name];
          if (!first || !second) {
            distances.push({ mode, sample: name, dOk: null });
            missing.push(`${mode} ${cssVariable}`);
            continue;
          }
          distances.push({ mode, sample: name, dOk: okDistance(first.okLab, second.okLab) });
        }
      }
      const values = distances.map((entry) => entry.dOk);
      const complete = values.every((value) => value !== null);
      const crossSkin = a.candidate.skinId !== b.candidate.skinId;
      pairs.push({
        left: a.candidate.id,
        right: b.candidate.id,
        leftSkinId: a.candidate.skinId,
        rightSkinId: b.candidate.skinId,
        crossSkin,
        distances,
        missing,
        complete,
        pairMeanDistance: complete ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        nearNeighborWarning: crossSkin && complete && values.every((value) => value < limits.nearNeighborDOk),
      });
    }
  }

  // 最近邻皮肤：只在不同皮肤之间找；并列按输入先序（确定性）
  const nearest = entries.map((entry) => {
    let best = null;
    for (const pair of pairs) {
      const isLeft = pair.left === entry.candidate.id;
      if (!isLeft && pair.right !== entry.candidate.id) continue;
      if (!pair.crossSkin || !pair.complete) continue;
      if (best !== null && pair.pairMeanDistance >= best.pairMeanDistance) continue;
      best = {
        candidateId: entry.candidate.id,
        skinId: entry.candidate.skinId,
        neighborId: isLeft ? pair.right : pair.left,
        neighborSkinId: isLeft ? pair.rightSkinId : pair.leftSkinId,
        pairMeanDistance: pair.pairMeanDistance,
        // 同一数组引用（不是副本）：最近邻条目自带六项距离，读的人不必回 pairs 里翻
        distances: pair.distances,
      };
    }
    return (
      best ?? {
        candidateId: entry.candidate.id,
        skinId: entry.candidate.skinId,
        neighborId: null,
        neighborSkinId: null,
        pairMeanDistance: null,
        incompleteReason: "没有可比较的其他皮肤候选，或六项距离不全",
      }
    );
  });

  return deepFreeze({
    samples: IDENTITY_SAMPLES.map((sample) => sample.name),
    modes: MODES.slice(),
    matrix,
    pairs,
    nearest,
    incomplete: pairs
      .filter((pair) => !pair.complete)
      .map((pair) => ({ left: pair.left, right: pair.right, missing: pair.missing })),
  });
}

/**
 * M3.4 汇总用的 diagnostics 字段：材质剖面 + 成对身份一次拿全。
 * 只汇总已有证据，缺项保持 incomplete，不把缺失补成通过或补成 0。
 */
export function diagnoseCandidates({ candidates, thresholds } = {}) {
  assertCandidates(candidates, "diagnoseCandidates");
  const limits = assertThresholds(thresholds);
  return deepFreeze({
    material: candidates.map((candidate) => diagnoseMaterial({ candidate, thresholds: limits })),
    identity: diagnoseIdentity({ candidates, thresholds: limits }),
  });
}

/**
 * 自检：诊断树里出现任何可被误读成阅读判定的键就报出来。
 * 对应卡面"材质或差异高分无法把文字失败翻成通过"——本函数 + 专项测试双锁。
 */
export function assertDiagnosticsCarryNoVerdict(diagnostics) {
  const offenders = [];
  const walk = (value, path) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (VERDICT_KEYS.has(key)) offenders.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(diagnostics, "$");
  return offenders;
}
