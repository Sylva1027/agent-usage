/**
 * M3.1 求解器可调用的快速角色检查（evaluatePalette）
 * ============================================================================
 *
 * 固定接口（总计划 §4.3）：
 *   evaluatePalette({ skinId, mode, tokens, roleCatalog, policy })
 *     → { entries, summary }
 *
 * 无 I/O、无 DOM、副作用为零；同输入输出逐字相同（输出深冻结、**输入绝不冻结**
 * ——sourceRefs 深拷贝后进输出）。M2 求解器经
 * solver.runEvaluator 的契约直接调用本函数（status ∈ pass/fail/unmeasured/
 * browser-required；判定角色携有限 ratio+threshold，未判角色 ratio=null），
 * 没有第二份阈值实现——阈值只读 M0 角色目录。
 *
 * 颜色来源（M3.1 卡面步骤 1-2，本模块不复制任何公式）：
 *   1. token 先过 M0 validateTokens（严格 #RRGGBB 十二键），再调用 M1.1
 *      derivePaletteDeclarationsFromTokens 取得真实 CSS 声明——主变量不透明
 *      HEX、陶瓷/hover/active-ink 等派生值（含 rgba）全部以 M1.1 输出为准。
 *   2. 声明未覆盖的固定色（--green/--red）取 BASE_COLORS：skinId=classic 读
 *      classic 分支，其余读 character[mode]（M1.4 同步值），两分支不串用。
 *   3. 样式表皮肤作用域的恒等别名按透传解析：--panel→--neo-surface、
 *      --track→--ceramic-well（styles.css 2371-2373/2395-2397）、
 *      --toggle-selected→--blue（styles.css 2546 后半段覆盖）。
 *   4. 未知变量、未知表达式、值不可解析 → unmeasured，不猜默认色；节点未接线
 *      即"声明未覆盖该变量"的同一机制。
 *
 * 判定口径（步骤 3-6）：
 *   - solid 背景精确检查；alpha 前景先 compositeSrgb 与实际背景合成（placeholder
 *     的 76% 混色不允许用原始 muted 替代）。
 *   - mix-srgb 按 M1.1 同款约定 left×(1−ratio)+right×ratio，premultiplied 插值
 *     （浏览器 color-mix 同等单位）；渐变按段 33 个等距样本（含端点）、
 *     premultiplied 插值，报告最差样本并标 approximate=true——最终须浏览器确认。
 *   - layered / canvas 背景（browserRequired）与 computed 前景（§4.4 的
 *     { kind: "computed", property, pseudo } 或目录现行的 null）→ browser-required，
 *     不计入 fast pass；computed 不是未知表达式，不得判 unmeasured。
 *   - 非颜色角色（decorative/logotype 等）与无阈值例外 → unmeasured（
 *     not-applicable，不入正文 PASS 数，由视觉评审承担）。
 *   - 每条结果含 roleId / threshold / ratio / 有效前景背景 / 最差采样点 / 方法 /
 *     sourceRefs；比值保留完整精度（4.499 判 fail，显示层四舍五入是报告的事）。
 *
 * 依赖申报（步骤 7 的支撑）：foregroundTokens / backgroundTokens 按"变量 → 喂入
 * token 键"依赖表归集（varSourceTokenDeps）——表只声明喂入关系，值全部来自
 * M1.1；固定色角色前景依赖为空，M2 由此把"固定色最高可达仍不合格"识别为
 * CONTRACT_CONFLICT、停止错误方向的搜索。test/skin-palette-quality.test.js 用
 * M1.1 作 oracle 逐变量校验敏感 token 集合与依赖表全等，两表漂移即红。
 */

import { validateTokens } from "./contracts.mjs";
import { compositeSrgb, contrastRatio, hexToSrgb, srgbToHex } from "./color-math.mjs";
import { BASE_COLORS } from "./roles.mjs";
import {
  CLASSIC_SKIN_ID,
  PALETTE_TOKEN_KEYS,
  derivePaletteDeclarationsFromTokens,
  isKnownMode,
  isKnownSkinId,
} from "../../public/skins.js";

const JUDGED_KINDS = new Set(["text", "graphic"]);
const GRADIENT_SAMPLES_PER_SEGMENT = 33;
const TOKEN_KEY_ORDER = new Map(PALETTE_TOKEN_KEYS.map((key, index) => [key, index]));

/** 样式表皮肤作用域的恒等别名：只透传目标变量，不复制任何颜色公式。 */
const VAR_ALIASES = Object.freeze({
  "--panel": "--neo-surface",
  "--track": "--ceramic-well",
  "--toggle-selected": "--blue",
});

/** 固定色变量（BASE_COLORS）：值不随候选 token 变化 → 空依赖（M2 固定色冲突判定的依据）。 */
const deps = (...keys) => Object.freeze(keys);

const FIXED_VAR_DEPS = Object.freeze({
  "--green": deps(),
  "--red": deps(),
});

/**
 * 变量 → 喂入 token 键（M1.1 derivePaletteDeclarations 的喂入关系镜像；模式分支
 * 与 skins.js 的 light/dark 分支一一对应）。值不在这里计算——颜色一律读 M1.1
 * 输出。未知变量返回 null。表内数组建表即冻结：导出时另发拷贝，外部改写（含
 * 原地 sort）永不污染本表——依赖表被污染会让后续求解按错依赖停搜。
 */
const VAR_TOKEN_DEPS = Object.freeze({
  "--bg": deps("pageBackground"),
  "--neo-surface": deps("panelBackground"),
  "--control": deps("controlBackground"),
  "--neo-edge": deps("panelBorder"),
  "--line": deps("panelBorder"),
  "--ink": deps("textPrimary"),
  "--muted": deps("textSecondary"),
  "--chart-text": deps("chartText"),
  "--chart-line": deps("panelBackground", "textPrimary"),
  "--blue": deps("accent"),
  "--record": deps("accent"),
  "--skin-active-accent": deps("accent"),
  "--active-ink": deps("accent"),
  "--ceramic-top": deps("panelBackground", "panelHighlight"),
  "--ceramic-light": deps("panelHighlight"),
  "--ceramic-rim": deps("panelHighlight"),
  "--ceramic-shade": deps("panelShadow"),
  ...FIXED_VAR_DEPS,
});

/** 模式分支的依赖集合（与 VAR_TOKEN_DEPS 同口径：每次导出都是新数组）。 */
const BRANCHED_TOKEN_DEPS = Object.freeze({
  "--control-hover": Object.freeze({
    light: deps("panelBackground", "panelShadow"),
    dark: deps("panelBackground", "panelHighlight"),
  }),
  "--ceramic-bottom": Object.freeze({
    light: deps("panelBackground", "pageBackground"),
    dark: deps("panelBackground", "panelShadow"),
  }),
  "--ceramic-well": Object.freeze({
    light: deps("pageBackground", "panelShadow"),
    dark: deps("pageBackground", "panelBackground"),
  }),
});

/**
 * 变量依赖申报（供测试与依赖归集）：返回该变量派生自哪些 token 键；固定色为
 * 空数组；未知变量为 null。**返回值是新数组**——调用方可自由改写（push/原地
 * sort 都不会碰到模块内部表）；表查找走自有属性语义（原型链上的 constructor
 * 等不算表项）。导出仅为 M0/M1.1 同步测试与诊断使用。
 */
export function varSourceTokenDeps(name, mode) {
  if (!isKnownMode(mode)) return null;
  const source = Object.hasOwn(VAR_ALIASES, name) ? VAR_ALIASES[name] : name;
  const branch = Object.hasOwn(BRANCHED_TOKEN_DEPS, source) ? BRANCHED_TOKEN_DEPS[source][mode] : undefined;
  const table = branch ?? (Object.hasOwn(VAR_TOKEN_DEPS, source) ? VAR_TOKEN_DEPS[source] : undefined);
  return table ? [...table] : null;
}

/**
 * "#RRGGBB" 与 M1.1 派生格式 `rgba(r, g, b, a)` → { rgb(0..1), alpha }。
 * 导出供 M3.3 材质诊断读取同一批真实声明（M1.1 只发这两种形态）——解析器只留
 * 一份，避免两份式子漂移。解析不了返回 null，调用方按缺测处理。
 */
export function parseDeclaredValue(value) {
  if (typeof value !== "string") return null;
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return { rgb: hexToSrgb(value), alpha: 1 };
  }
  const rgba = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (\d+(?:\.\d+)?)\)$/.exec(value);
  if (rgba) {
    const rgb = [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255];
    return { rgb, alpha: Number(rgba[4]) };
  }
  return null;
}

/** 有效颜色显示形态：不透明 HEX 或与 M1.1 派生同款的 rgba() 字符串。 */
function formatColor(color) {
  if (color.alpha >= 1) return srgbToHex(color.rgb);
  const bytes = color.rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
  return `rgba(${bytes.join(", ")}, ${color.alpha})`;
}

/**
 * §4.4：foreground 可以是 ColorExpr，或 `{ kind: "computed", property, pseudo }`
 * ——实际色只从浏览器计算样式取得（M3.2 的测量对象）；历史上 null/undefined 也
 * 表示同一语义（角色目录现状）。computed 节点不是"未知表达式"：不得判
 * unmeasured，必须交浏览器。
 */
function isComputedForeground(foreground) {
  if (foreground === null || foreground === undefined) return true;
  return typeof foreground === "object" && foreground.kind === "computed";
}

/** computed 前景的浏览器测量指引：读哪个属性、哪个伪元素（M3.2 据此路由）。 */
function computedForegroundDetail(foreground) {
  if (!foreground || typeof foreground !== "object") return "前景实际色仅浏览器可得（computed）";
  const property = typeof foreground.property === "string" ? foreground.property : "color";
  const pseudo = typeof foreground.pseudo === "string" ? foreground.pseudo : null;
  return `前景实际色仅浏览器可得（computed：${property}${pseudo ? ` @ ${pseudo}` : ""}）`;
}

/**
 * 颜色表达式求值（§4.4：var / literal / alpha / mix-srgb）。
 * 返回 { ok: true, color } 或 { ok: false, reason }——reason 直接进 unmeasured
 * 的 methodDetail，不猜默认色。
 */
function resolveColorExpr(expr, context) {
  if (!expr || typeof expr !== "object" || typeof expr.kind !== "string") {
    return { ok: false, reason: "颜色表达式缺失或非法" };
  }
  switch (expr.kind) {
    case "literal": {
      if (typeof expr.value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(expr.value)) {
        return { ok: false, reason: `未知字面量格式：${String(expr.value)}` };
      }
      return { ok: true, color: { rgb: hexToSrgb(expr.value), alpha: 1 } };
    }
    case "var": {
      if (typeof expr.name !== "string") return { ok: false, reason: "var 表达式缺变量名" };
      const source = VAR_ALIASES[expr.name] ?? expr.name;
      const raw = context.declared.get(source) ?? context.baseColors[source];
      if (raw === undefined) {
        return { ok: false, reason: `未知变量 ${expr.name}（声明未覆盖且非固定色）` };
      }
      const parsed = parseDeclaredValue(raw);
      if (!parsed) return { ok: false, reason: `变量 ${expr.name} 值不可解析：${raw}` };
      return { ok: true, color: parsed };
    }
    case "alpha": {
      if (typeof expr.alpha !== "number" || !Number.isFinite(expr.alpha) || expr.alpha < 0 || expr.alpha > 1) {
        return { ok: false, reason: `alpha 表达式的 alpha 非法：${String(expr.alpha)}` };
      }
      const inner = resolveColorExpr(expr.color, context);
      if (!inner.ok) return inner;
      // 与 M1.1 paletteColourWithAlpha / 浏览器 color-mix(x%, transparent) 同语义：替换 alpha
      return { ok: true, color: { rgb: inner.color.rgb, alpha: expr.alpha } };
    }
    case "mix-srgb": {
      if (typeof expr.ratio !== "number" || !Number.isFinite(expr.ratio) || expr.ratio < 0 || expr.ratio > 1) {
        return { ok: false, reason: `mix-srgb 的 ratio 非法：${String(expr.ratio)}` };
      }
      const left = resolveColorExpr(expr.left, context);
      if (!left.ok) return left;
      const right = resolveColorExpr(expr.right, context);
      if (!right.ok) return right;
      return { ok: true, color: mixColors(left.color, right.color, expr.ratio) };
    }
    default:
      if (expr.kind === "computed") {
        return { ok: false, reason: "computed 只能作为整体前景表达式（嵌套使用交浏览器实测）" };
      }
      return { ok: false, reason: `未知颜色表达式 kind: ${expr.kind}` };
  }
}

/**
 * sRGB premultiplied 插值（浏览器 color-mix / 渐变同等单位）：
 * 结果 = left×(1−t) + right×t，alpha 同比插值后回除。
 */
function mixColors(left, right, t) {
  const mixedAlpha = left.alpha * (1 - t) + right.alpha * t;
  if (mixedAlpha <= 0) return { rgb: [0, 0, 0], alpha: 0 };
  const rgb = [0, 1, 2].map((index) => {
    const front = left.rgb[index] * left.alpha;
    const back = right.rgb[index] * right.alpha;
    return (front * (1 - t) + back * t) / mixedAlpha;
  });
  return { rgb, alpha: mixedAlpha };
}

/** 颜色表达式的 token 依赖归集（未知变量贡献空集——该角色此时本就 unmeasured）。 */
function collectColorDeps(expr, mode, into) {
  if (!expr || typeof expr !== "object" || typeof expr.kind !== "string") return into;
  switch (expr.kind) {
    case "literal":
      return into;
    case "var": {
      const deps = varSourceTokenDeps(expr.name, mode);
      for (const key of deps ?? []) into.add(key);
      return into;
    }
    case "alpha":
      return collectColorDeps(expr.color, mode, into);
    case "mix-srgb":
      collectColorDeps(expr.left, mode, into);
      return collectColorDeps(expr.right, mode, into);
    default:
      return into;
  }
}

function collectBackgroundDeps(background, mode, into) {
  if (!background || typeof background !== "object") return into;
  switch (background.kind) {
    case "solid":
      return collectColorDeps(background.color, mode, into);
    case "linear-gradient":
      for (const stop of background.stops ?? []) collectColorDeps(stop?.color, mode, into);
      return into;
    default:
      return into;
  }
}

/** 依赖集合 → 按 PALETTE_TOKEN_KEYS 注册序排序的数组（输出顺序稳定）。 */
function sortedDeps(set) {
  return [...set].sort((a, b) => (TOKEN_KEY_ORDER.get(a) ?? 99) - (TOKEN_KEY_ORDER.get(b) ?? 99));
}

/** 渐变按段等距取样：每段 33 点（含两端），返回 { position, rgb } 数组。 */
function sampleGradient(stops) {
  const samples = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    for (let step = 0; step < GRADIENT_SAMPLES_PER_SEGMENT; step += 1) {
      const t = step / (GRADIENT_SAMPLES_PER_SEGMENT - 1);
      const mixed = mixColors(from.color, to.color, t);
      samples.push({ position: from.offset + (to.offset - from.offset) * t, rgb: mixed.rgb });
    }
  }
  return samples;
}

/** 纯数据深拷贝（对象/数组/原语）——切断输出与输入的共享引用。 */
function copyPlainData(value) {
  if (Array.isArray(value)) return value.map((item) => copyPlainData(item));
  if (value && typeof value === "object") {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = copyPlainData(value[key]);
    return copy;
  }
  return value;
}

/**
 * sourceRefs 深拷贝后进输出：输出深冻结会递归冻结所有可达对象——直引调用方角色
 * 目录会连输入一起冻住（M2.3 profileSnapshot 同款教训，纯函数不得改输入）。
 */
function copySourceRefs(role) {
  if (!Array.isArray(role.sourceRefs)) return [];
  return role.sourceRefs.map((ref) => copyPlainData(ref));
}

/** 非判定结果（unmeasured / browser-required）的公共构造。 */
function nonJudgedEntry(role, status, method, methodDetail, context) {
  const foregroundTokens = sortedDeps(collectColorDeps(role.foreground, context.mode, new Set()));
  const backgroundTokens = sortedDeps(collectBackgroundDeps(role.background, context.mode, new Set()));
  return {
    roleId: role.id,
    required: role.required === true,
    status,
    ratio: null,
    threshold: typeof role.threshold === "number" && Number.isFinite(role.threshold) ? role.threshold : null,
    foregroundTokens,
    backgroundTokens,
    method,
    methodDetail,
    approximate: false,
    effectiveForeground: null,
    effectiveBackground: null,
    worstSample: null,
    sourceRefs: copySourceRefs(role),
  };
}

/** 单角色快速检查：按卡面步骤 2-7 的出口顺序分派。 */
function evaluateRole(role, context) {
  if (!role || typeof role !== "object" || typeof role.id !== "string" || role.id.length === 0) {
    throw new TypeError("evaluatePalette: roleCatalog 条目缺 id");
  }
  const kind = role.kind;
  if (kind === "decorative") {
    return nonJudgedEntry(role, "unmeasured", "not-applicable", "装饰例外（视觉评审项，不入正文 PASS 数）", context);
  }
  if (kind === "logotype") {
    return nonJudgedEntry(role, "unmeasured", "not-applicable", "压印字标例外（总计划 §5.7，视觉评审项）", context);
  }
  if (!JUDGED_KINDS.has(kind)) {
    return nonJudgedEntry(role, "unmeasured", "not-applicable", `非颜色角色 kind: ${String(kind)}`, context);
  }
  if (typeof role.threshold !== "number" || !Number.isFinite(role.threshold)) {
    return nonJudgedEntry(role, "unmeasured", "not-applicable", "无阈值例外（不入正文 PASS 数）", context);
  }

  const background = role.background;
  if (
    !background ||
    typeof background !== "object" ||
    background.kind === "layered" ||
    background.kind === "canvas" ||
    background.browserRequired === true
  ) {
    const detail =
      background && typeof background.description === "string" ? background.description : "背景类型需浏览器实测";
    return nonJudgedEntry(role, "browser-required", "browser-required", detail, context);
  }
  if (isComputedForeground(role.foreground)) {
    return nonJudgedEntry(
      role,
      "browser-required",
      "browser-required",
      computedForegroundDetail(role.foreground),
      context,
    );
  }

  if (background.kind === "solid") {
    const resolvedBackground = resolveColorExpr(background.color, context);
    if (!resolvedBackground.ok) {
      return nonJudgedEntry(role, "unmeasured", "unmeasured", resolvedBackground.reason, context);
    }
    if (resolvedBackground.color.alpha < 1) {
      return nonJudgedEntry(role, "unmeasured", "unmeasured", "solid 背景携带 alpha，下垫色未定义", context);
    }
    const resolvedForeground = resolveColorExpr(role.foreground, context);
    if (!resolvedForeground.ok) {
      return nonJudgedEntry(role, "unmeasured", "unmeasured", resolvedForeground.reason, context);
    }
    const foreground = resolvedForeground.color;
    const effective =
      foreground.alpha < 1
        ? compositeSrgb(foreground.rgb, foreground.alpha, resolvedBackground.color.rgb)
        : foreground.rgb;
    const ratio = contrastRatio(effective, resolvedBackground.color.rgb);
    return {
      roleId: role.id,
      required: role.required === true,
      status: ratio >= role.threshold ? "pass" : "fail",
      ratio,
      threshold: role.threshold,
      foregroundTokens: sortedDeps(collectColorDeps(role.foreground, context.mode, new Set())),
      backgroundTokens: sortedDeps(collectBackgroundDeps(background, context.mode, new Set())),
      method: foreground.alpha < 1 ? "alpha-composite" : "solid",
      methodDetail:
        foreground.alpha < 1 ? `alpha 前景先与实际背景合成后判定（${formatColor(foreground)}）` : "solid 背景精确检查",
      approximate: false,
      effectiveForeground: formatColor(foreground),
      effectiveBackground: formatColor(resolvedBackground.color),
      worstSample: null,
      sourceRefs: copySourceRefs(role),
    };
  }

  if (background.kind === "linear-gradient") {
    const stops = Array.isArray(background.stops) ? background.stops : [];
    let offsetsValid = stops.length >= 2;
    let previousOffset = -Infinity;
    const resolvedStops = [];
    for (const stop of stops) {
      const offset = stop?.offset;
      if (
        typeof offset !== "number" ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset > 1 ||
        offset <= previousOffset
      ) {
        offsetsValid = false;
        break;
      }
      const resolved = resolveColorExpr(stop?.color, context);
      if (!resolved.ok) return nonJudgedEntry(role, "unmeasured", "unmeasured", resolved.reason, context);
      if (resolved.color.alpha < 1) {
        return nonJudgedEntry(role, "unmeasured", "unmeasured", "渐变 stop 携带 alpha，下垫色未定义", context);
      }
      previousOffset = offset;
      resolvedStops.push({ offset, color: resolved.color });
    }
    if (!offsetsValid || resolvedStops[0].offset !== 0 || resolvedStops[resolvedStops.length - 1].offset !== 1) {
      return nonJudgedEntry(role, "unmeasured", "unmeasured", "渐变 stop 定义不合 §4.4（0→1 递增且含两端）", context);
    }
    const resolvedForeground = resolveColorExpr(role.foreground, context);
    if (!resolvedForeground.ok) {
      return nonJudgedEntry(role, "unmeasured", "unmeasured", resolvedForeground.reason, context);
    }
    const foreground = resolvedForeground.color;
    let worst = null;
    for (const sample of sampleGradient(resolvedStops)) {
      const effective =
        foreground.alpha < 1 ? compositeSrgb(foreground.rgb, foreground.alpha, sample.rgb) : foreground.rgb;
      const ratio = contrastRatio(effective, sample.rgb);
      if (!worst || ratio < worst.ratio) {
        worst = { position: sample.position, background: srgbToHex(sample.rgb), ratio };
      }
    }
    return {
      roleId: role.id,
      required: role.required === true,
      status: worst.ratio >= role.threshold ? "pass" : "fail",
      ratio: worst.ratio,
      threshold: role.threshold,
      foregroundTokens: sortedDeps(collectColorDeps(role.foreground, context.mode, new Set())),
      backgroundTokens: sortedDeps(collectBackgroundDeps(background, context.mode, new Set())),
      method: "gradient-samples",
      methodDetail:
        `${background.angle ?? "?"}° 渐变按段 ${GRADIENT_SAMPLES_PER_SEGMENT} 等距样本取最差` +
        (foreground.alpha < 1 ? `；alpha 前景先与每处背景合成（${formatColor(foreground)}）` : ""),
      approximate: true,
      effectiveForeground: formatColor(foreground),
      effectiveBackground: null,
      worstSample: worst,
      sourceRefs: copySourceRefs(role),
    };
  }

  return nonJudgedEntry(role, "unmeasured", "unmeasured", `未知背景表达式 kind: ${String(background?.kind)}`, context);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 快速角色检查（纯函数）：对角色目录逐角色求值并汇总。角色目录来自 M0（注入），
 * 阈值只读目录，policy 参与校验但阈值口径不在本模块另设。
 */
export function evaluatePalette(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("evaluatePalette: 需要 options 对象");
  }
  const { skinId, mode, tokens, roleCatalog, policy } = options;
  if (!isKnownSkinId(skinId)) {
    throw new TypeError(`evaluatePalette: 未知皮肤 "${String(skinId)}"`);
  }
  if (!isKnownMode(mode)) {
    throw new TypeError(`evaluatePalette: 未知模式 "${String(mode)}"`);
  }
  const tokenVerdict = validateTokens(tokens);
  if (!tokenVerdict.valid) {
    const detail = tokenVerdict.errors
      .slice(0, 3)
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("；");
    throw new TypeError(`evaluatePalette: tokens 未过 M0 校验：${detail}`);
  }
  if (!Array.isArray(roleCatalog)) {
    throw new TypeError("evaluatePalette: roleCatalog 必须是角色目录数组（M0 注入）");
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("evaluatePalette: policy 必须是 M0 policy 对象");
  }

  // M1.1 真实声明（含派生 rgba）；classic 与 character 固定色分支不串用
  const declarationPairs = derivePaletteDeclarationsFromTokens(tokens, mode) ?? [];
  const declared = new Map(declarationPairs);
  const baseColors = skinId === CLASSIC_SKIN_ID ? BASE_COLORS.classic[mode] : BASE_COLORS.character[mode];
  const context = { mode, declared, baseColors };

  const entries = roleCatalog.map((role) => evaluateRole(role, context));
  const counts = { pass: 0, fail: 0, unmeasured: 0, browserRequired: 0 };
  const requiredFailures = [];
  let approximateCount = 0;
  for (const entry of entries) {
    if (entry.status === "pass") counts.pass += 1;
    else if (entry.status === "fail") counts.fail += 1;
    else if (entry.status === "unmeasured") counts.unmeasured += 1;
    else counts.browserRequired += 1;
    if (entry.required && entry.status === "fail") requiredFailures.push(entry.roleId);
    if (entry.approximate) approximateCount += 1;
  }
  const summary = {
    skinId,
    mode,
    total: entries.length,
    counts,
    requiredFailures,
    approximateCount,
  };
  return deepFreeze({ entries, summary });
}
