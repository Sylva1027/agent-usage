/**
 * M2.2 有界前景求解：单个模式内，在 M2.1 固定表面模板给出的背景修正组上，
 * 按固定顺序（textPrimary → textSecondary → chartText → accent）有界搜索四个
 * 前景 token。真实角色判定一律经注入的 evaluatePalette（M3.1 固定接口）——
 * 本模块不实现第二份阈值或派生逻辑，只消费其逐角色结果。
 *
 * 对评估器输出的消费契约（M3.1 落地时须满足，见 M2.2 交接）——从严校验、不符即
 * TypeError，不设缺省：
 *   evaluatePalette({ skinId, mode, tokens, roleCatalog, policy }) →
 *   { entries: [{ roleId, required, status: "pass" | "fail" | "unmeasured" |
 *      "browser-required", ratio, threshold, foregroundTokens, backgroundTokens }] }
 *   roleId 非空、required 必为布尔；pass/fail 的 ratio/threshold 必为有限数值
 *   （判定过的角色必须留下判定依据）；unmeasured/browser-required 不得携带 ratio、
 *   threshold 须为数值或 null。foregroundTokens/backgroundTokens 必填且逐键校验
 *   属于 12 token 键集——缺省为空会让"角色达标但未达搜索目标"的 τ 约束静默失效；
 *   controlText/controlBorder 由本模块按镜像归源为 textPrimary/panelBorder 后再
 *   参与匹配（镜像语义归消费方，与 setToken 一致）。固定色（BASE_COLORS）角色
 *   两数组为空。
 *
 * 求解语义（按 M2.2 卡面）：
 *   - 每 token：C 阶梯 [1, .85, .7, .5, .25, 0] × 目标 C（accent 过滤 minC 以下，
 *     gamut 降 C 后同样核查 minC）；每层 L 在允许区间均匀 129 点含端点；每个试值
 *     转最终 HEX 代回完整 token 后整体评估；网格按 HEX 缓存，预算只计实际评估调用。
 *   - 主文字先在同一网格结果挑 7.2 可行点，无解降 4.7 并记 preferredContrastUnmet
 *     （不重复网格）；其余文字 4.7；accent 只按角色阈值。搜索目标只绑定正文类角色
 *     （阈值 ≥ policy.readability.bodyTextMin），图形/装饰类按自身阈值判定。
 *   - 每 C 层选离起点 L 最近的可行区段（多段取距离最小、随后较小 L，不假定单调），
 *     区段两侧边界各细化 ≤16 次；最终选择：达目标 → |ΔL| 最小 → |ΔC| 最小 →
 *     固定 L/C 顺序。
 *   - 搜索只考虑依赖已就绪 token 的角色（依赖尚无解 token 的耦合角色留给轮末重查，
 *     避免用起点值误判）。每轮结束整体重查所有角色，失败角色涉及的前景 token 下一
 *     轮重搜；未知依赖的轮末失败（依赖声明不覆盖的派生耦合）防御性全体重搜。最多
 *     policy.searchBudget.maxCouplingRounds 轮。token 无可行点时：第 1 轮且不可行
 *     约束不涉及其他求解 token（纯自身/背景不可行）→ 本组失败换下一组；涉及耦合
 *     或已是第 ≥2 轮 → 保留现值继续，由轮末重查与后续 token 决定能否修复；轮次
 *     用尽仍有失败则本组失败。
 *   - 预算：每 token 每轮 policy.searchBudget.maxTrialsPerTokenPerRound 次试值；
 *     耗尽即停并记录，不加轮数、不降门槛；耗尽即搜索未完成，即使中途已遇可行点
 *     也按 SEARCH_BUDGET_EXCEEDED 处理（不完整搜索不得宣布成功）；某组预算耗尽
 *     后整组循环即停，不以新预算尝试后续修正组（"不增加无限重试"）。
 *   - 背景修正：先做与求解 token 无关角色的组级预检；固定色（foregroundTokens 为
 *     空）必要角色在所有组上都不可达 → CONTRACT_CONFLICT（不搜索无关前景）；组内
 *     第 1 轮某 token 无可行点 → 换下一组；全部组失败按 CONTRACT_CONFLICT >
 *     SEARCH_BUDGET_EXCEEDED > UNSATISFIABLE 归并。
 *   - 失败出口不输出半套颜色：失败结果不含 tokens 字段。无解/预算耗尽出口附角色
 *     证据（roleEvidence）：已评估点中各相关必要角色的最高可达比值里仍不满足自身
 *     要求（或绑定的搜索目标）者——供失败记录引用"失败角色/最差比值"，即使第 1 轮
 *     换组从未走到轮末重查。unsat 是完整搜索集内的最高可达；预算耗尽出口是耗尽前
 *     的部分观测，搜索未完成、不作最高可达论断（失败记录消息必须带此限定）。
 */

import { fitSrgbGamut, srgbToHex } from "./color-math.mjs";

export const SOLVE_ORDER = Object.freeze(["textPrimary", "textSecondary", "chartText", "accent"]);

export const C_LADDER_STEPS = Object.freeze([1, 0.85, 0.7, 0.5, 0.25, 0]);
export const GRID_POINT_COUNT = 129;
export const MAX_REFINE_STEPS = 16;

export const SOLVE_STATUS = Object.freeze({
  SOLVED: "SOLVED",
  UNSATISFIABLE: "UNSATISFIABLE",
  CONTRACT_CONFLICT: "CONTRACT_CONFLICT",
  SEARCH_BUDGET_EXCEEDED: "SEARCH_BUDGET_EXCEEDED",
});

const MODES = Object.freeze(["light", "dark"]);
const BACKGROUND_KEYS = Object.freeze([
  "pageBackground",
  "panelBackground",
  "panelHighlight",
  "panelShadow",
  "panelBorder",
  "controlBackground",
]);
const HEX_RE = /^#[0-9A-F]{6}$/;
const ENTRY_STATUSES = Object.freeze(["pass", "fail", "unmeasured", "browser-required"]);
/** 依赖申报合法键 = 12 token 键集；controlText/controlBorder 消费前按镜像归源。 */
const TOKEN_KEYS = Object.freeze([...BACKGROUND_KEYS, ...SOLVE_ORDER, "controlText", "controlBorder"]);

function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`solveModeForegrounds: ${name} 必须是有限数值（收到 ${String(value)}）`);
  }
  return value;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 镜像归源：controlText 求解为 textPrimary、controlBorder 为 panelBorder 背景镜像。 */
function sourceTokenOf(key) {
  if (key === "controlText") return "textPrimary";
  if (key === "controlBorder") return "panelBorder";
  return key;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertSpec(spec, name) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError(`solveModeForegrounds: ${name} 必须是规格对象`);
  }
  assertFiniteNumber(spec.startL, `${name}.startL`);
  assertFiniteNumber(spec.lMin, `${name}.lMin`);
  assertFiniteNumber(spec.lMax, `${name}.lMax`);
  assertFiniteNumber(spec.hue, `${name}.hue`);
  if (!(spec.lMin < spec.lMax)) {
    throw new TypeError(`solveModeForegrounds: ${name}.lMin 必须小于 lMax`);
  }
}

function normalizeForegrounds(foregrounds) {
  if (!foregrounds || typeof foregrounds !== "object" || Array.isArray(foregrounds)) {
    throw new TypeError("solveModeForegrounds: foregrounds 必须是前景规格对象");
  }
  for (const key of SOLVE_ORDER) {
    assertSpec(foregrounds[key], `foregrounds.${key}`);
    if (key === "accent") continue; // accent 用 cTarget/minC，无 maxC
    assertFiniteNumber(foregrounds[key].maxC, `foregrounds.${key}.maxC`);
    if (foregrounds[key].maxC < 0) {
      throw new TypeError(`solveModeForegrounds: foregrounds.${key}.maxC 不得为负`);
    }
  }
  const accent = foregrounds.accent;
  assertFiniteNumber(accent.cTarget, "foregrounds.accent.cTarget");
  assertFiniteNumber(accent.minC, "foregrounds.accent.minC");
  if (accent.cTarget < 0 || accent.minC < 0) {
    throw new TypeError("solveModeForegrounds: accent 的 cTarget/minC 不得为负");
  }
  return foregrounds;
}

function normalizeCorrections(corrections, limit) {
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new TypeError("solveModeForegrounds: corrections 必须是非空修正组数组");
  }
  const groups = corrections.slice(0, limit);
  if (groups.length === 0) {
    throw new TypeError("solveModeForegrounds: searchBudget.maxBackgroundAttemptsPerVariant 至少为 1");
  }
  for (const [index, group] of groups.entries()) {
    if (!group || typeof group !== "object") {
      throw new TypeError(`solveModeForegrounds: corrections[${index}] 必须是修正组对象`);
    }
    const backgrounds = group.backgrounds;
    if (!backgrounds || typeof backgrounds !== "object") {
      throw new TypeError(`solveModeForegrounds: corrections[${index}].backgrounds 缺失`);
    }
    for (const key of BACKGROUND_KEYS) {
      if (typeof backgrounds[key] !== "string" || !HEX_RE.test(backgrounds[key])) {
        throw new TypeError(`solveModeForegrounds: corrections[${index}].backgrounds.${key} 须为大写 #RRGGBB`);
      }
    }
  }
  return groups;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("solveModeForegrounds: policy 缺失");
  }
  const readability = policy.readability;
  if (!readability || typeof readability !== "object") {
    throw new TypeError("solveModeForegrounds: policy.readability 缺失");
  }
  assertFiniteNumber(readability.bodyTextMin, "policy.readability.bodyTextMin");
  const solver = policy.solver;
  if (!solver || typeof solver !== "object") {
    throw new TypeError("solveModeForegrounds: policy.solver 缺失");
  }
  assertFiniteNumber(solver.primaryTextTarget, "policy.solver.primaryTextTarget");
  assertFiniteNumber(solver.bodyTextTarget, "policy.solver.bodyTextTarget");
  const budget = policy.searchBudget;
  if (!budget || typeof budget !== "object") {
    throw new TypeError("solveModeForegrounds: policy.searchBudget 缺失");
  }
  for (const key of ["maxTrialsPerTokenPerRound", "maxCouplingRounds", "maxBackgroundAttemptsPerVariant"]) {
    assertFiniteNumber(budget[key], `policy.searchBudget.${key}`);
    if (budget[key] < 1 || !Number.isInteger(budget[key])) {
      throw new TypeError(`solveModeForegrounds: policy.searchBudget.${key} 必须是 ≥1 的整数`);
    }
  }
  return policy;
}

/** 单个 (L, C, H) 试值 → 最终 HEX 与实现记录；accent 低于 minC 的点视为无效。 */
function buildTrial(spec, L, requestedC, isAccent) {
  const fitted = fitSrgbGamut({ L, C: requestedC, H: spec.hue });
  if (isAccent && fitted.lch.C < spec.minC) return null;
  return { hex: srgbToHex(fitted.rgb), finalL: fitted.lch.L, finalC: fitted.lch.C };
}

/** 规格起点处的 token 初值（尚无解 token 在评估上下文中的占位，与求解选择无关）。 */
function startToken(spec, isAccent) {
  const targetC = isAccent ? spec.cTarget : spec.maxC;
  const built = buildTrial(spec, spec.startL, targetC, isAccent);
  return built ? built.hex : srgbToHex(fitSrgbGamut({ L: spec.startL, C: spec.minC, H: spec.hue }).rgb);
}

/**
 * 规范化评估器输出：契约形状不符显式报错（M3.1 集成期第一时间暴露），不猜默认。
 * 依赖数组缺省为空会让"角色达标但未达搜索目标（τ）"的约束静默失效——求解器无从
 * 知道该动哪个 token；判定过（pass/fail）的角色必须留下 ratio/threshold 判定依据。
 * 导出给 M2.3 generate 复用：最终 HEX 重查与求解期共用同一份契约校验与镜像归源，
 * 不产生第二份消费实现。
 */
function runEvaluator(evaluatePalette, request) {
  const result = evaluatePalette(request);
  if (!result || typeof result !== "object" || !Array.isArray(result.entries)) {
    throw new TypeError("solveModeForegrounds: evaluatePalette 必须返回 { entries: [...] }");
  }
  return result.entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(`solveModeForegrounds: entries[${index}] 必须是对象`);
    }
    if (typeof entry.roleId !== "string" || entry.roleId.length === 0) {
      throw new TypeError(`solveModeForegrounds: entries[${index}].roleId 不符合契约（非空字符串）`);
    }
    if (!ENTRY_STATUSES.includes(entry.status)) {
      throw new TypeError(`solveModeForegrounds: entries[${index}].status 不符合契约`);
    }
    if (typeof entry.required !== "boolean") {
      throw new TypeError(`solveModeForegrounds: entries[${index}].required 不符合契约（必为布尔）`);
    }
    if (entry.status === "pass" || entry.status === "fail") {
      if (!finiteNonNegative(entry.ratio)) {
        throw new TypeError(
          `solveModeForegrounds: entries[${index}]（${entry.roleId}）ratio 不符合契约（判定角色须为有限数值）`,
        );
      }
      if (!finiteNonNegative(entry.threshold)) {
        throw new TypeError(
          `solveModeForegrounds: entries[${index}]（${entry.roleId}）threshold 不符合契约（判定角色须为有限数值）`,
        );
      }
    } else {
      if (entry.ratio != null) {
        throw new TypeError(
          `solveModeForegrounds: entries[${index}]（${entry.roleId}）ratio 不符合契约（未测角色不得携带比值）`,
        );
      }
      // threshold 契约为"数值或 null"：undefined（字段缺失）同样违约——null 是显式
      // 声明，undefined 是没写，二者不等价（ratio 的缺省是未测角色的正常形态，threshold 不是）
      if (entry.threshold !== null && !finiteNonNegative(entry.threshold)) {
        throw new TypeError(
          `solveModeForegrounds: entries[${index}]（${entry.roleId}）threshold 不符合契约（未测角色须为数值或 null）`,
        );
      }
    }
    for (const field of ["foregroundTokens", "backgroundTokens"]) {
      if (!Array.isArray(entry[field])) {
        throw new TypeError(
          `solveModeForegrounds: entries[${index}].${field} 不符合契约（须为 token 键数组，不允许缺省）`,
        );
      }
      for (const key of entry[field]) {
        if (!TOKEN_KEYS.includes(key)) {
          throw new TypeError(
            `solveModeForegrounds: entries[${index}].${field} 不符合契约（未知 token 键 ${String(key)}）`,
          );
        }
      }
    }
    // 镜像归源后再参与匹配：约束绑定到真正的求解 token，不因控制键声明而静默失效
    return {
      ...entry,
      foregroundTokens: entry.foregroundTokens.map(sourceTokenOf),
      backgroundTokens: entry.backgroundTokens.map(sourceTokenOf),
    };
  });
}

export { runEvaluator };

/** 求解 token 的相关角色摘要：依赖含 T、其余依赖均已定值、必要、可测（pass/fail）。 */
function summarizeForToken(entries, tokenId, readySet) {
  let minRatio = Number.POSITIVE_INFINITY;
  let allPass = true;
  let measurable = 0;
  const related = [];
  const pending = [];
  for (const entry of entries) {
    const deps = [...entry.foregroundTokens, ...entry.backgroundTokens];
    if (!deps.includes(tokenId)) continue;
    if (!entry.required) continue;
    // 其余依赖尚无定值（选中或保留前）的角色留给轮末重查，避免用起点占位误判
    if (deps.some((token) => token !== tokenId && SOLVE_ORDER.includes(token) && !readySet.has(token))) {
      pending.push(entry.roleId);
      continue;
    }
    if (entry.status === "unmeasured" || entry.status === "browser-required") {
      pending.push(entry.roleId);
      continue;
    }
    measurable += 1;
    if (entry.status !== "pass") allPass = false;
    if (entry.status === "pass" && typeof entry.ratio === "number") {
      minRatio = Math.min(minRatio, entry.ratio);
    }
    related.push({ roleId: entry.roleId, threshold: entry.threshold, ratio: entry.ratio });
  }
  return {
    minRatio: measurable ? minRatio : Number.POSITIVE_INFINITY,
    allPass,
    measurable,
    related,
    pending,
  };
}

/**
 * 求解目标 τ（4.7/7.2）只绑定正文类角色（阈值 ≥ policy.readability.bodyTextMin）：
 * 4.5 的正文硬门被抬到搜索目标；图形（3.0）/装饰类角色按自身阈值判定——否则低阈值
 * 耦合角色会被搜索目标错杀。
 */
function meetsTargets(summary, tau, bodyFloor) {
  if (tau === null) return true;
  return summary.related.every((entry) => {
    if (entry.threshold === null || entry.threshold < bodyFloor) return true;
    return typeof entry.ratio === "number" && entry.ratio >= tau;
  });
}

function feasibleAt(summary, tau, bodyFloor) {
  if (summary.measurable === 0) return true; // 无相关必要角色：任意点可行，最终取最近起点
  if (!summary.allPass) return false;
  return meetsTargets(summary, tau, bodyFloor);
}

/** C 阶梯：目标 C × 固定步长，去重；accent 过滤 minC 以下。 */
function buildLadder(spec, isAccent) {
  const targetC = isAccent ? spec.cTarget : spec.maxC;
  const seen = new Set();
  const layers = [];
  for (const step of C_LADDER_STEPS) {
    const c = targetC * step;
    if (seen.has(c)) continue;
    seen.add(c);
    if (isAccent && c < spec.minC) continue;
    layers.push(c);
  }
  return layers;
}

/**
 * 一次单 token 有界搜索。context 在本函数内只改变 tokenId（及 controlText 镜像），
 * 其余 token 保持调用时取值——网格缓存因此以 HEX 为键。
 * 返回 { status: "chosen" | "unsat" | "budget", best?, preferredContrastUnmet?, trials, roleEvidence, ... }；
 * roleEvidence 仅在 unsat 出口非空：仍不满足要求的角色及其最高可达比值。
 */
function searchToken(tokenId, spec, context, state) {
  const isAccent = tokenId === "accent";
  const targetC = isAccent ? spec.cTarget : spec.maxC;
  const budget = { used: 0, limit: state.policy.searchBudget.maxTrialsPerTokenPerRound, exhausted: false };
  const cache = new Map();
  const bestByRole = new Map();
  const originalHex = context[tokenId];
  let crossConstrained = false;
  let crossDetected = false;
  const diagnostic = {
    tokenId,
    gridPointsEvaluated: 0,
    refinedPointsEvaluated: 0,
    cacheHits: 0,
    floorSkipped: 0,
    refinementTruncated: false,
    crossConstrained: false,
    tau: null,
  };

  const evaluate = (hex) => {
    if (cache.has(hex)) {
      diagnostic.cacheHits += 1;
      return cache.get(hex);
    }
    if (budget.used >= budget.limit) {
      budget.exhausted = true;
      return null;
    }
    setToken(context, tokenId, hex);
    const entries = runEvaluator(state.evaluatePalette, {
      skinId: state.skinId,
      mode: state.mode,
      tokens: { ...context },
      roleCatalog: state.roleCatalog,
      policy: state.policy,
    });
    budget.used += 1;
    const summary = summarizeForToken(entries, tokenId, state.readySet);
    if (!crossDetected) {
      // 相关角色的清单在整个搜索内不变（同评估器同目录），首次评估即可判定本
      // token 的不可行约束是否涉及其他求解 token（耦合）——决定无解时换组还是保留
      crossDetected = true;
      crossConstrained = entries.some((entry) => {
        if (!entry.required || (entry.status !== "pass" && entry.status !== "fail")) return false;
        const deps = [...entry.foregroundTokens, ...entry.backgroundTokens];
        return (
          deps.includes(tokenId) &&
          deps.every((token) => token === tokenId || !SOLVE_ORDER.includes(token) || state.readySet.has(token)) &&
          deps.some((token) => token !== tokenId && SOLVE_ORDER.includes(token))
        );
      });
      diagnostic.crossConstrained = crossConstrained;
    }
    const outcome = { summary, entries };
    // 角色证据：搜索集内每个相关必要角色的最高可达比值（缓存命中重扫同值，无副作用）
    for (const related of summary.related) {
      if (typeof related.ratio !== "number" || !Number.isFinite(related.ratio)) continue;
      const previous = bestByRole.get(related.roleId);
      if (!previous || related.ratio > previous.ratio) {
        bestByRole.set(related.roleId, {
          roleId: related.roleId,
          ratio: related.ratio,
          threshold: related.threshold,
        });
      }
    }
    cache.set(hex, outcome);
    return outcome;
  };

  const attempt = (tau) => {
    diagnostic.tau = tau;
    const pool = [];
    const layers = buildLadder(spec, isAccent);
    for (const [layerIndex, requestedC] of layers.entries()) {
      // 网格：129 点含端点
      const points = new Array(GRID_POINT_COUNT).fill(null);
      for (let i = 0; i < GRID_POINT_COUNT; i += 1) {
        const L = spec.lMin + ((spec.lMax - spec.lMin) * i) / (GRID_POINT_COUNT - 1);
        const built = buildTrial(spec, L, requestedC, isAccent);
        if (!built) {
          diagnostic.floorSkipped += 1;
          continue;
        }
        const outcome = evaluate(built.hex);
        if (!outcome) continue; // 预算耗尽：该点未评估，不计入可行集
        diagnostic.gridPointsEvaluated += 1;
        points[i] = { L, requestedC, ...built, ...outcome.summary, layerIndex, index: i };
      }
      // 可行区段：连续可行索引；多段取离起点最近（随后较小 L），不假定单调
      const segments = [];
      let current = null;
      for (let i = 0; i < GRID_POINT_COUNT; i += 1) {
        const point = points[i];
        if (point && feasibleAt(point, tau, state.bodyFloor)) {
          if (!current) current = { start: i, points: [] };
          current.points.push(point);
          current.end = i;
        } else if (current) {
          segments.push(current);
          current = null;
        }
      }
      if (current) segments.push(current);
      if (!segments.length) continue;
      const nearestOf = (segment) =>
        segment.points.reduce(
          (best, point) => {
            const distance = Math.abs(point.L - spec.startL);
            if (distance < best.distance) return { distance, L: point.L };
            if (distance === best.distance && point.L < best.L) return { distance, L: point.L };
            return best;
          },
          { distance: Number.POSITIVE_INFINITY, L: Number.POSITIVE_INFINITY },
        );
      const chosen = segments.reduce(
        (best, segment) => {
          const nearest = nearestOf(segment);
          if (nearest.distance !== best.nearest.distance)
            return nearest.distance < best.nearest.distance ? { nearest, segment } : best;
          if (nearest.L !== best.nearest.L) return nearest.L < best.nearest.L ? { nearest, segment } : best;
          return best;
        },
        { nearest: nearestOf(segments[0]), segment: segments[0] },
      );
      // 区段两侧边界各细化 ≤16 次（预算与缓存共用；accent 地板点按不可行处理）。
      // 括点取网格索引对应的 L（accent 地板跳空处也适用）；可行中点把可行界推 向
      // 不可行侧，不可行中点把不可行界推向可行侧。
      const gridL = (index) => spec.lMin + ((spec.lMax - spec.lMin) * index) / (GRID_POINT_COUNT - 1);
      const refineEdge = (badIndex, goodIndex) => {
        let badL = gridL(badIndex);
        let goodL = gridL(goodIndex);
        for (let step = 0; step < MAX_REFINE_STEPS; step += 1) {
          const midL = (badL + goodL) / 2;
          const built = buildTrial(spec, midL, requestedC, isAccent);
          if (!built) {
            badL = midL;
            continue;
          }
          const outcome = evaluate(built.hex);
          if (!outcome) {
            diagnostic.refinementTruncated = true;
            return;
          }
          diagnostic.refinedPointsEvaluated += 1;
          const point = { L: midL, requestedC, ...built, ...outcome.summary, layerIndex, index: goodIndex };
          if (feasibleAt(point, tau, state.bodyFloor)) {
            pool.push(point);
            goodL = midL;
          } else {
            badL = midL;
          }
        }
      };
      const badLeft = chosen.segment.start - 1;
      if (badLeft >= 0) refineEdge(badLeft, chosen.segment.start);
      const badRight = chosen.segment.end + 1;
      if (badRight < GRID_POINT_COUNT) refineEdge(badRight, chosen.segment.end);
      for (const point of chosen.segment.points) pool.push(point);
    }
    if (!pool.length) return null;
    // 最终选择：|ΔL| → |ΔC| → 固定 L/C 顺序（池内点都已达当前目标）
    return pool.reduce((best, point) => {
      const dL = Math.abs(point.L - spec.startL);
      const bestDL = Math.abs(best.L - spec.startL);
      if (dL !== bestDL) return dL < bestDL ? point : best;
      const dC = Math.abs(point.finalC - targetC);
      const bestDC = Math.abs(best.finalC - targetC);
      if (dC !== bestDC) return dC < bestDC ? point : best;
      if (point.L !== best.L) return point.L < best.L ? point : best;
      if (point.finalC !== best.finalC) return point.finalC < best.finalC ? point : best;
      return point;
    });
  };

  const taus =
    tokenId === "textPrimary"
      ? [...new Set([state.policy.solver.primaryTextTarget, state.policy.solver.bodyTextTarget])]
      : [tokenId === "accent" ? null : state.policy.solver.bodyTextTarget];
  let best = null;
  let preferredContrastUnmet = false;
  let lastTau = null; // 最后一次尝试的搜索目标（预算耗尽时 = 耗尽时正在进行的目标）
  for (const [index, tau] of taus.entries()) {
    lastTau = tau;
    best = attempt(tau);
    if (best) {
      preferredContrastUnmet = index > 0;
      break;
    }
    if (budget.exhausted) break; // 预算耗尽：不降门槛继续
  }
  // 预算耗尽 = 搜索未完成：即使中途已遇可行点，也不得用不完整搜索数据宣布成功
  // （卡面：耗尽即停并记录 → SEARCH_BUDGET_EXCEEDED；best 仅留诊断参考）
  const status = budget.exhausted ? "budget" : best ? "chosen" : "unsat";
  // 无解/预算耗尽出口的角色证据：已评估点中每个相关必要角色的最高可达比值里，仍
  // 不满足自身要求（或绑定的搜索目标）者——失败记录"失败角色/最差比值"的证据来源
  // （总计划 §5）。unsat = 完整搜索集内最高可达；budget = 耗尽前的部分观测，搜索
  // 未完成、不作最高可达论断（记录消息必须带此限定）。
  let roleEvidence = [];
  if (status !== "chosen") {
    const finalTau = lastTau;
    roleEvidence = [...bestByRole.values()]
      .filter((role) => {
        const bound = role.threshold >= state.bodyFloor;
        const requirement = bound && finalTau !== null ? Math.max(finalTau, role.threshold) : role.threshold;
        return role.ratio < requirement;
      })
      .sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
  }
  if (status === "chosen") {
    setToken(context, tokenId, best.hex);
  } else {
    // 非选中出口：恢复入口取值，避免最后一次试值污染后续评估上下文
    setToken(context, tokenId, originalHex);
  }
  return {
    status,
    best,
    preferredContrastUnmet,
    budget,
    diagnostic,
    roleEvidence,
  };
}

function setToken(context, tokenId, hex) {
  context[tokenId] = hex;
  if (tokenId === "textPrimary") context.controlText = hex;
}

/** 组级上下文：修正组背景 + 规格起点占位 + 镜像控制 token。 */
function buildContext(group, foregrounds) {
  const context = { ...group.backgrounds };
  for (const tokenId of SOLVE_ORDER) {
    context[tokenId] = startToken(foregrounds[tokenId], tokenId === "accent");
  }
  context.controlText = context.textPrimary;
  context.controlBorder = context.panelBorder;
  return context;
}

/**
 * 求解单个模式的前景四 token。
 * 返回 SOLVED（含完整 12 token）或失败码（不含 tokens）；详见模块注释。
 */
export function solveModeForegrounds(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("solveModeForegrounds: 需要 options 对象");
  }
  const { skinId, roleCatalog, evaluatePalette } = options;
  if (typeof evaluatePalette !== "function") {
    throw new TypeError("solveModeForegrounds: evaluatePalette 必须是函数（M3.1 evaluatePalette 或等价注入）");
  }
  if (roleCatalog === undefined || roleCatalog === null) {
    throw new TypeError("solveModeForegrounds: roleCatalog 缺失");
  }
  if (!MODES.includes(options.mode)) {
    throw new TypeError(`solveModeForegrounds: mode 必须是 ${MODES.join(" / ")}`);
  }
  const policy = normalizePolicy(options.policy);
  const foregrounds = normalizeForegrounds(options.foregrounds);
  const groups = normalizeCorrections(options.corrections, policy.searchBudget.maxBackgroundAttemptsPerVariant);

  const state = {
    skinId,
    mode: options.mode,
    roleCatalog,
    policy,
    evaluatePalette,
    bodyFloor: policy.readability.bodyTextMin,
  };
  const attempts = [];

  for (const [groupIndex, group] of groups.entries()) {
    const attempt = attemptGroup(group, groupIndex, foregrounds, state);
    if (attempt.status === SOLVE_STATUS.SOLVED) return deepFreeze(attempt.result);
    attempts.push(attempt.summary);
    // 耗尽即停的组级闭合：某组预算耗尽后不再以新预算尝试后续修正组——
    // "不增加无限重试"，后续组只能重走同一搜索形态
    if (attempt.summary.outcome === "budget") break;
  }

  let status = SOLVE_STATUS.UNSATISFIABLE;
  if (attempts.every((attempt) => attempt.outcome === "fixed-blocked")) {
    status = SOLVE_STATUS.CONTRACT_CONFLICT;
  } else if (attempts.some((attempt) => attempt.outcome === "budget")) {
    status = SOLVE_STATUS.SEARCH_BUDGET_EXCEEDED;
  }
  return deepFreeze({ status, mode: state.mode, attempts });
}

function attemptGroup(group, groupIndex, foregrounds, state) {
  const context = buildContext(group, foregrounds);
  // 就绪集合：当前上下文中已有定值（选中或显式保留）的求解 token——耦合角色只有
  // 在其余依赖全部就绪后才进入搜索
  const readySet = new Set();
  state.readySet = readySet;
  const counters = { preChecks: 0, roundChecks: 0 };
  const checkAll = () =>
    runEvaluator(state.evaluatePalette, {
      skinId: state.skinId,
      mode: state.mode,
      tokens: { ...context },
      roleCatalog: state.roleCatalog,
      policy: state.policy,
    });

  // 组级预检：与求解 token 无关的必要角色（固定色、背景层角色）先行判定
  counters.preChecks += 1;
  const preEntries = checkAll();
  const preFails = preEntries.filter(
    (entry) =>
      entry.required &&
      entry.status === "fail" &&
      !entry.foregroundTokens.some((token) => SOLVE_ORDER.includes(token)) &&
      !entry.backgroundTokens.some((token) => SOLVE_ORDER.includes(token)),
  );
  if (preFails.length) {
    const fixedFails = preFails.filter((entry) => entry.foregroundTokens.length === 0);
    return {
      status: "group-failed",
      summary: {
        outcome: fixedFails.length ? "fixed-blocked" : "background-blocked",
        groupIndex,
        fixedRoles: fixedFails.map((entry) => ({
          roleId: entry.roleId,
          ratio: entry.ratio,
          threshold: entry.threshold,
        })),
        backgroundRoles: preFails
          .filter((entry) => entry.foregroundTokens.length > 0)
          .map((entry) => ({ roleId: entry.roleId, ratio: entry.ratio, threshold: entry.threshold })),
      },
    };
  }

  // 轮次循环：每轮按固定顺序搜索待解 token，轮末整体重查
  const maxRounds = state.policy.searchBudget.maxCouplingRounds;
  const perToken = new Map();
  const trialsByToken = {};
  let pending = [...SOLVE_ORDER];
  let preferredContrastUnmet = false;
  const diagnostics = [];
  let budgetExhausted = false;

  for (let round = 1; round <= maxRounds; round += 1) {
    let groupBroken = null;
    let brokenEvidence = [];
    for (const tokenId of pending) {
      const outcome = searchToken(tokenId, foregrounds[tokenId], context, state);
      trialsByToken[`${tokenId}#r${round}`] = outcome.budget.used;
      diagnostics.push({ round, ...outcome.diagnostic, status: outcome.status });
      if (outcome.status === "chosen") {
        perToken.set(tokenId, outcome.best);
        readySet.add(tokenId);
      } else if (outcome.status === "unsat") {
        // 保留现值也算定值：后续 token 的耦合搜索按它进行
        readySet.add(tokenId);
      }
      if (outcome.status === "budget") {
        budgetExhausted = true;
        groupBroken = "budget";
        brokenEvidence = outcome.roleEvidence ?? [];
        break;
      }
      if (outcome.status === "unsat") {
        // 第 1 轮且不可行约束不涉及其他求解 token = 本组背景对它不可行，换下一组；
        // 涉及耦合或已是第 ≥2 轮 = 保留现值，交给轮末重查与后续 token
        if (round === 1 && !outcome.diagnostic.crossConstrained) {
          groupBroken = "unsat";
          brokenEvidence = outcome.roleEvidence ?? [];
          break;
        }
      }
      if (outcome.status === "chosen" && outcome.preferredContrastUnmet) preferredContrastUnmet = true;
    }
    if (groupBroken) {
      return {
        status: "group-failed",
        summary: {
          outcome: groupBroken,
          groupIndex,
          round,
          roundsUsed: round,
          trialsByToken,
          diagnostics,
          budgetExhausted,
          // 中断出口统一附角色证据：失败记录需要失败角色与比值——unsat = 完整搜索
          // 集内最高可达，budget = 耗尽前部分观测（generate 消息须带未完成限定）
          roleEvidence: brokenEvidence,
        },
      };
    }

    counters.roundChecks += 1;
    const entries = checkAll();
    const fails = entries.filter((entry) => entry.required && entry.status === "fail");
    if (!fails.length) {
      const unmeasuredRoles = entries.filter((entry) => entry.status === "unmeasured").map((entry) => entry.roleId);
      const browserRequiredRoles = entries
        .filter((entry) => entry.status === "browser-required")
        .map((entry) => entry.roleId);
      const tokens = deepFreeze({ ...context });
      const solvedTokens = {};
      for (const tokenId of SOLVE_ORDER) {
        const record = perToken.get(tokenId);
        solvedTokens[tokenId] = record
          ? {
              hex: context[tokenId],
              requestedC: record.requestedC,
              finalL: record.finalL,
              finalC: record.finalC,
              hue: foregrounds[tokenId].hue,
            }
          : { hex: context[tokenId], note: "无可行约束，保留规格起点值" };
      }
      return {
        status: SOLVE_STATUS.SOLVED,
        result: {
          status: SOLVE_STATUS.SOLVED,
          mode: state.mode,
          skinId: state.skinId,
          correctionGroupIndex: groupIndex,
          tokens,
          solvedTokens,
          preferredContrastUnmet,
          roundsUsed: round,
          trials: { byToken: trialsByToken, preChecks: counters.preChecks, roundChecks: counters.roundChecks },
          budgetLimits: { ...state.policy.searchBudget },
          unmeasuredRoles,
          browserRequiredRoles,
        },
      };
    }
    const involved = new Set();
    for (const fail of fails) {
      for (const token of [...fail.foregroundTokens, ...fail.backgroundTokens]) {
        if (SOLVE_ORDER.includes(token)) involved.add(token);
      }
    }
    // 依赖声明未覆盖的轮末失败（派生耦合元数据缺口）→ 防御性全体重搜
    const next = involved.size ? SOLVE_ORDER.filter((token) => involved.has(token)) : [...SOLVE_ORDER];
    if (round === maxRounds) {
      return {
        status: "group-failed",
        summary: {
          outcome: "unsat",
          groupIndex,
          round,
          roundsUsed: round,
          trialsByToken,
          diagnostics,
          failingRoles: fails.map((entry) => ({
            roleId: entry.roleId,
            ratio: entry.ratio,
            threshold: entry.threshold,
          })),
        },
      };
    }
    pending = next;
  }
  throw new Error("solveModeForegrounds: 轮次循环不可达出口（内部错误）");
}
