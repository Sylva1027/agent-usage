/**
 * M3.1 skin-palette fast role checks (node --test).
 *
 * Anchors: the M3.1 card's fixed interface evaluatePalette({ skinId, mode,
 * tokens, roleCatalog, policy }) and its exit ordering (solid exact, alpha
 * composite, gradient 33-samples-per-segment approximate, browser-required for
 * layered/canvas/computed-foreground, unmeasured for unknown vars/expressions,
 * not-applicable for decorative/logotype/threshold-less roles). The dependency
 * table is validated against M1.1's derivePaletteDeclarationsFromTokens as the
 * oracle — no second copy of any colour formula exists here. No DOM, no I/O
 * beyond reading this module's own source for the purity scan.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";

import { evaluatePalette, parseDeclaredValue, varSourceTokenDeps } from "../scripts/skin-palette/evaluate.mjs";
import {
  assertDiagnosticsCarryNoVerdict,
  DIAGNOSTIC_THRESHOLDS,
  diagnoseCandidates,
  diagnoseIdentity,
  diagnoseMaterial,
  IDENTITY_SAMPLES,
  MATERIAL_SURFACES,
} from "../scripts/skin-palette/diagnostics.mjs";
import {
  captureStableFullPage,
  captureStableViewport,
  buildColorObserverSource,
  buildProbeSource,
  installBrowserColorObserver,
  measureBrowserRoles,
  probeToastNativeOcclusion,
  screenshotWithStyleAttributeGuard,
} from "../scripts/skin-palette/browser-measure.mjs";
import { adaptRoleCatalogForMeasurement, measurementErrorTrace } from "../scripts/skin-palette/capture.mjs";
import { ROLE_CATALOG, BASE_COLORS } from "../scripts/skin-palette/roles.mjs";
import { runEvaluator } from "../scripts/skin-palette/solver.mjs";
import {
  MODES,
  canonicalJson,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  validateAssessment,
  validateCandidate,
} from "../scripts/skin-palette/contracts.mjs";
import {
  APPROXIMATE_METHOD_SUFFIX,
  RECORDED_INPUT_FIELDS,
  REQUIRED_SOURCE_FILES,
  VISUAL_REVIEW_ITEMS,
  assessCandidate,
  fastResultToRecords,
} from "../scripts/skin-palette/assess.mjs";
import {
  compositeSrgb,
  contrastRatio,
  hexToSrgb,
  okDistance,
  srgbToHex,
  srgbToOklab,
} from "../scripts/skin-palette/color-math.mjs";
import { PALETTE_TOKEN_KEYS, derivePaletteDeclarationsFromTokens, paletteTokens } from "../public/skins.js";
import {
  GLM_PRICES_URL,
  KIMI_PRICES_URL,
  LITELLM_PRICES_URL,
  MIMO_PRICES_URL,
  MODEL_PRICES_URL,
  STEPFUN_PRICES_URL,
  USD_CNY_RATE_URL,
} from "../src/pricing-auto.js";
import { createUsageServer } from "../src/server.js";
import { createPaletteFixture, createPaletteServerOptions } from "../test-support/skin-palette-fixture.mjs";

const M31_POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

/** 与默认浅色主题量级一致的合法十二键调色板（结构测试用）。 */
const M31_TOKENS = Object.freeze({
  pageBackground: "#F4F1EA",
  panelBackground: "#FBF8F2",
  panelBorder: "#D8D2C4",
  panelHighlight: "#FFFFFF",
  panelShadow: "#C9C2B2",
  textPrimary: "#23313C",
  textSecondary: "#455666",
  accent: "#007D91",
  controlBackground: "#FBF8F2",
  controlBorder: "#D8D2C4",
  controlText: "#23313C",
  chartText: "#455666",
});

const m31Role = (overrides = {}) => ({
  id: "synthetic.role",
  kind: "text",
  selector: null,
  states: ["dashboard-default"],
  foreground: { kind: "var", name: "--ink" },
  background: { kind: "solid", color: { kind: "var", name: "--bg" } },
  threshold: 4.5,
  required: true,
  applicability: "",
  sourceRefs: [],
  ...overrides,
});

const m31Run = ({
  skinId = "chatgpt",
  mode = "light",
  tokens = M31_TOKENS,
  roles = [m31Role()],
  policy = M31_POLICY,
} = {}) => evaluatePalette({ skinId, mode, tokens, roleCatalog: roles, policy });

test("M3.1：固定接口与 M2 兼容——真实目录逐角色求值，逐条过 solver.runEvaluator 契约，汇总自洽", () => {
  const result = m31Run({ roles: ROLE_CATALOG });
  assert.equal(result.entries.length, ROLE_CATALOG.length);
  assert.equal(result.summary.total, ROLE_CATALOG.length);
  assert.equal(result.summary.skinId, "chatgpt");
  assert.equal(result.summary.mode, "light");
  const sum = Object.values(result.summary.counts).reduce((left, right) => left + right, 0);
  assert.equal(sum, result.summary.total, "四状态计数之和 = 总数");
  // M2 直接导入：输出经 solver 的评估器契约校验（status 四值、判定带有限比值、依赖为合法 token 键）
  const echoed = runEvaluator(evaluatePalette, {
    skinId: "chatgpt",
    mode: "light",
    tokens: M31_TOKENS,
    roleCatalog: ROLE_CATALOG,
    policy: M31_POLICY,
  });
  assert.equal(echoed.length, ROLE_CATALOG.length);
  for (const entry of echoed) {
    if (entry.status === "pass" || entry.status === "fail") {
      assert.ok(Number.isFinite(entry.ratio) && entry.ratio >= 1, `${entry.roleId} 判定角色须带有限比值`);
    } else {
      assert.equal(entry.ratio, null, `${entry.roleId} 未判角色比值必须为 null`);
    }
  }
  // 必要角色不得停留在 unmeasured（那意味着目录里有变量没接上——接线缺陷）
  for (const entry of echoed) {
    if (entry.required) {
      assert.notEqual(entry.status, "unmeasured", `${entry.roleId} 为必要角色却 unmeasured：${entry.methodDetail}`);
    }
  }
  // 深冻结：同输入二次调用逐字相同
  const second = m31Run({ roles: ROLE_CATALOG });
  assert.equal(JSON.stringify(second), JSON.stringify(result));
});

test("M3.1：solid 精确判定——比值与 color-math 逐位一致（完整精度不四舍五入），恰好低于阈值即失败", () => {
  const fg = "#23313C";
  const bg = "#F4F1EA";
  const result = m31Run({
    roles: [
      m31Role({
        foreground: { kind: "literal", value: fg },
        background: { kind: "solid", color: { kind: "literal", value: bg } },
      }),
    ],
  });
  const entry = result.entries[0];
  assert.equal(entry.status, "pass");
  assert.equal(entry.method, "solid");
  assert.equal(entry.ratio, contrastRatio(hexToSrgb(fg), hexToSrgb(bg)), "比值 = color-math 原值（无舍入）");
  assert.equal(entry.approximate, false);

  // 阈值 4.5 下找一对 4.495–4.499 的贴近失败对：显示层会四舍五入成 4.50，判定必须仍 fail。
  // 灰阶逐字节步进约 0.05 跨过窗口；改扫 (v,v,w) 族——b 通道权重小，步进 ~0.002 足够落窗
  let nearMiss = null;
  const byteHex = (byte) => byte.toString(16).toUpperCase().padStart(2, "0");
  outer: for (let v = 0x70; v <= 0x80; v += 1) {
    for (let w = 0x00; w <= v; w += 1) {
      const fg = `#${byteHex(v)}${byteHex(v)}${byteHex(w)}`;
      const ratio = contrastRatio(hexToSrgb(fg), hexSrgbWhite());
      if (ratio > 4.495 && ratio < 4.499) {
        nearMiss = { fg, bg: "#FFFFFF", ratio };
        break outer;
      }
    }
  }
  assert.ok(nearMiss, "测试前置：应在灰阶组合中找到 4.495–4.499 的贴近失败对");
  const failed = m31Run({
    roles: [
      m31Role({
        foreground: { kind: "literal", value: nearMiss.fg },
        background: { kind: "solid", color: { kind: "literal", value: nearMiss.bg } },
      }),
    ],
  }).entries[0];
  assert.equal(failed.status, "fail", `${nearMiss.fg} 对 ${nearMiss.bg} 比值 ${nearMiss.ratio} 低于 4.5 必须失败`);
  assert.equal(failed.ratio, nearMiss.ratio, "失败也保留完整精度比值（4.499 不得显示成 4.5 后蒙混）");
});

function hexSrgbWhite() {
  return hexToSrgb("#FFFFFF");
}

test("M3.1：alpha 前景先与实际背景合成——placeholder 的 76% 混色不得用原始 muted 替代", () => {
  const result = m31Run({
    roles: [
      m31Role({
        id: "input.placeholder",
        foreground: { kind: "alpha", color: { kind: "var", name: "--muted" }, alpha: 0.76 },
        background: { kind: "solid", color: { kind: "var", name: "--control" } },
      }),
    ],
  });
  const entry = result.entries[0];
  assert.equal(entry.method, "alpha-composite");
  assert.equal(entry.effectiveForeground, "rgba(69, 86, 102, 0.76)", "有效前景 = 76% alpha 的 muted（非原始 muted）");
  const composed = compositeSrgb(hexToSrgb("#455666"), 0.76, hexToSrgb(M31_TOKENS.controlBackground));
  assert.equal(entry.ratio, contrastRatio(composed, hexToSrgb(M31_TOKENS.controlBackground)), "比值按合成后颜色计算");
  assert.deepEqual(entry.foregroundTokens, ["textSecondary"]);
  assert.deepEqual(entry.backgroundTokens, ["controlBackground"]);
});

test("M3.1：渐变中间最差——端点双过而中段凹陷失败，报告最差采样点并标 approximate", () => {
  // 红(255,0,0)→绿(0,255,0) 的 sRGB 凸性使中点 (127.5,127.5,0) 亮度低于两端；
  // #141414 对两端 ≥4.5、对中点 <4.5——最差值只能取中段采样（卡面禁止只看端点）
  const fg = "#141414";
  const stops = [
    { offset: 0, color: { kind: "literal", value: "#FF0000" } },
    { offset: 1, color: { kind: "literal", value: "#00FF00" } },
  ];
  const result = m31Run({
    roles: [
      m31Role({
        foreground: { kind: "literal", value: fg },
        background: { kind: "linear-gradient", angle: 90, stops },
      }),
    ],
  });
  const entry = result.entries[0];
  assert.equal(entry.status, "fail", "中段采样失败即失败");
  assert.equal(entry.method, "gradient-samples");
  assert.equal(entry.approximate, true, "渐变快速诊断声明 approximate，最终须浏览器确认");
  // sRGB 凸性使红→绿的插值亮度在 t≈0.28 处凹陷到比两端都暗——最差点必须落在该凹陷，
  // 且严格差于两个端点（卡面禁止只看最亮/最暗端点）
  assert.ok(entry.worstSample.position > 0.1 && entry.worstSample.position < 0.45, "最差采样点在中段凹陷处");
  const endpointRatios = stops.map((stop) => contrastRatio(hexToSrgb(fg), hexToSrgb(stop.color.value)));
  assert.ok(entry.ratio < Math.min(...endpointRatios), "最差比值严格差于两个端点（凹陷确实存在）");
  assert.equal(entry.ratio, entry.worstSample.ratio);
  // worstSample.background 是 8 位 HEX 显示舍入；判定用未舍入采样——复算只在舍入误差内一致
  const recomputed = contrastRatio(hexToSrgb(fg), hexToSrgb(entry.worstSample.background));
  assert.ok(Math.abs(entry.ratio - recomputed) < 0.01, "最差比值可由留档背景样本复算（舍入容差内）");
  // 对照：亮度单调的灰阶渐变（#808080→#FFFFFF）不存在凸性凹陷，纯黑全采样 ≥4.5 → 通过
  const passing = m31Run({
    roles: [
      m31Role({
        foreground: { kind: "literal", value: "#000000" },
        background: {
          kind: "linear-gradient",
          angle: 90,
          stops: [
            { offset: 0, color: { kind: "literal", value: "#808080" } },
            { offset: 1, color: { kind: "literal", value: "#FFFFFF" } },
          ],
        },
      }),
    ],
  }).entries[0];
  assert.equal(passing.status, "pass");
  assert.ok(passing.ratio >= 4.5);
});

test("M3.1：未知变量 / 未知表达式 / 未知背景 / 非颜色角色 / 无阈值——一律 unmeasured，不猜默认色", () => {
  const roles = [
    m31Role({ id: "synthetic.unknown-var", foreground: { kind: "var", name: "--nope" } }),
    m31Role({ id: "synthetic.unknown-expr", foreground: { kind: "weird", value: "#123456" } }),
    m31Role({ id: "synthetic.unknown-bg", background: { kind: "radial", color: { kind: "var", name: "--ink" } } }),
    m31Role({ id: "synthetic.non-color", kind: "visible", threshold: 4.5 }),
    m31Role({ id: "synthetic.no-threshold", threshold: null, required: false }),
  ];
  const result = m31Run({ roles });
  const byId = new Map(result.entries.map((entry) => [entry.roleId, entry]));
  const unknownVar = byId.get("synthetic.unknown-var");
  assert.equal(unknownVar.status, "unmeasured");
  assert.match(unknownVar.methodDetail, /未知变量 --nope/);
  assert.equal(byId.get("synthetic.unknown-expr").status, "unmeasured");
  assert.match(byId.get("synthetic.unknown-expr").methodDetail, /未知颜色表达式/);
  assert.equal(byId.get("synthetic.unknown-bg").status, "unmeasured");
  assert.match(byId.get("synthetic.unknown-bg").methodDetail, /未知背景表达式/);
  assert.equal(byId.get("synthetic.non-color").status, "unmeasured");
  assert.match(byId.get("synthetic.non-color").methodDetail, /非颜色角色/);
  assert.equal(byId.get("synthetic.no-threshold").method, "not-applicable");
  assert.equal(byId.get("synthetic.no-threshold").ratio, null);
  assert.equal(result.summary.counts.pass, 0, "不得把只有输入格式有效的角色当阅读 PASS");
});

test("M3.1：装饰与字标例外——不入正文 PASS 数，由视觉评审承担", () => {
  const exceptionIds = new Set([
    "deco.character-art",
    "logotype.agent-usage",
    "deco.bar-fill-fallback",
    "button.hover-border",
    "chart.model-bar",
    "chart.detail-fill",
    "spotlight.tinted-surface",
  ]);
  const roles = ROLE_CATALOG.filter((role) => exceptionIds.has(role.id));
  const result = m31Run({ roles });
  for (const entry of result.entries) {
    assert.equal(entry.status, "unmeasured", `${entry.roleId} 例外不入判定`);
    assert.equal(entry.method, "not-applicable");
    assert.equal(entry.required, false);
    assert.equal(entry.ratio, null);
  }
  assert.equal(result.summary.counts.pass, 0);
});

test("M3.1：layered / canvas 背景与空前景——browser-required，不计入 fast pass", () => {
  const roles = ROLE_CATALOG.filter((role) =>
    ["chart.axis-text", "chart.timeline-segment", "chart.legend-swatch"].includes(role.id),
  );
  const result = m31Run({ roles });
  const byId = new Map(result.entries.map((entry) => [entry.roleId, entry]));
  assert.equal(byId.get("chart.axis-text").status, "browser-required", "canvas 背景 → 浏览器实测");
  assert.equal(byId.get("chart.axis-text").threshold, 4.5, "未判角色保留目录阈值");
  assert.equal(byId.get("chart.axis-text").ratio, null);
  assert.equal(byId.get("chart.timeline-segment").status, "browser-required", "canvas + 分类色实际绘制");
  assert.equal(byId.get("chart.legend-swatch").status, "browser-required", "前景为 JS 固定分类色，仅浏览器可得");
  assert.equal(result.summary.counts.pass, 0);
});

test("M3.1 复核回归：输出深冻结不连带冻结调用方输入——sourceRefs 深拷贝（M2.3 profileSnapshot 同款教训）", () => {
  const role = m31Role({ sourceRefs: [{ file: "public/styles.css", symbol: ".x", line: 12 }] });
  const result = m31Run({ roles: [role] });
  // 输出契约不变：整体与 entry 仍深冻结
  assert.ok(Object.isFrozen(result), "输出整体冻结");
  assert.ok(Object.isFrozen(result.entries[0]), "entry 冻结");
  assert.ok(Object.isFrozen(result.entries[0].sourceRefs), "entry.sourceRefs 冻结");
  // 调用方输入未被冻结、仍可改写
  assert.equal(Object.isFrozen(role), false, "调用方角色对象不得被冻结");
  assert.equal(Object.isFrozen(role.sourceRefs), false, "调用方 sourceRefs 数组不得被冻结");
  assert.equal(Object.isFrozen(role.sourceRefs[0]), false, "调用方 sourceRefs 元素不得被冻结");
  assert.notEqual(result.entries[0].sourceRefs[0], role.sourceRefs[0], "元素为拷贝而非共享引用");
  // 拷贝独立：改调用方输入不改变已产出的输出
  role.sourceRefs.push({ file: "public/app.js", symbol: "y", line: 3 });
  role.sourceRefs[0].line = 99;
  assert.equal(result.entries[0].sourceRefs.length, 1, "输出拷贝不随后续 push 变长");
  assert.equal(result.entries[0].sourceRefs[0].line, 12, "输出拷贝的值不被调用方改写");
});

test("M3.1 复核回归：§4.4 computed 前景节点交浏览器（browser-required），不当未知表达式", () => {
  // 实施计划 §4.4：foreground 可以是 ColorExpr，或 { kind: "computed", property, pseudo }
  const roles = [
    m31Role({ id: "synthetic.computed-plain", foreground: { kind: "computed", property: "color", pseudo: null } }),
    m31Role({
      id: "synthetic.computed-placeholder",
      foreground: { kind: "computed", property: "color", pseudo: "::placeholder" },
    }),
    m31Role({ id: "synthetic.computed-null", foreground: null }),
    m31Role({
      id: "synthetic.computed-nested",
      foreground: { kind: "alpha", color: { kind: "computed", property: "color", pseudo: null }, alpha: 0.76 },
    }),
  ];
  const byId = new Map(m31Run({ roles }).entries.map((entry) => [entry.roleId, entry]));
  const plain = byId.get("synthetic.computed-plain");
  assert.equal(plain.status, "browser-required", "computed 前景必须交浏览器，不得判 unmeasured/未知表达式");
  assert.equal(plain.ratio, null);
  assert.equal(plain.threshold, 4.5, "未判角色保留目录阈值");
  assert.match(plain.methodDetail, /computed：color/);
  assert.deepEqual(plain.foregroundTokens, [], "computed 前景无 token 依赖");
  const placeholder = byId.get("synthetic.computed-placeholder");
  assert.equal(placeholder.status, "browser-required");
  assert.match(placeholder.methodDetail, /@ ::placeholder/, "伪元素路由信息进 methodDetail（M3.2 按此读伪元素样式）");
  assert.equal(byId.get("synthetic.computed-null").status, "browser-required", "null 前瞻量保持同语义");
  const nested = byId.get("synthetic.computed-nested");
  assert.equal(nested.status, "unmeasured", "嵌套 computed 超出 §4.4 顶层面定义 → unmeasured 不猜色");
  assert.match(nested.methodDetail, /computed/);
});

test("M3.1 复核回归：varSourceTokenDeps 导出发拷贝——调用方改写不污染模块依赖表", () => {
  const first = varSourceTokenDeps("--bg", "light");
  assert.deepEqual(first, ["pageBackground"]);
  first.push("controlText");
  first.sort();
  first.length = 0;
  assert.deepEqual(varSourceTokenDeps("--bg", "light"), ["pageBackground"], "返回数组被清空/改写后表不受污染");
  assert.notEqual(varSourceTokenDeps("--bg", "light"), varSourceTokenDeps("--bg", "light"), "每次调用都是新数组");
  // 别名透传目标同样发拷贝
  const alias = varSourceTokenDeps("--panel", "light");
  alias.push("chartText");
  assert.deepEqual(varSourceTokenDeps("--neo-surface", "light"), ["panelBackground"], "别名目标同样不受污染");
  // 固定色空依赖也是拷贝
  const fixed = varSourceTokenDeps("--green", "light");
  fixed.push("accent");
  assert.deepEqual(varSourceTokenDeps("--green", "light"), [], "固定色空依赖不被调用方 push 污染");
  // 模式分支拷贝
  const hover = varSourceTokenDeps("--control-hover", "light");
  hover.push("accent");
  assert.deepEqual(varSourceTokenDeps("--control-hover", "light"), ["panelBackground", "panelShadow"]);
  assert.deepEqual(varSourceTokenDeps("--control-hover", "dark"), ["panelBackground", "panelHighlight"]);
  // 原型链键与未知变量一律 null——不得继承 Object.prototype 成员
  for (const probe of ["constructor", "toString", "hasOwnProperty", "__proto__", "--nope"]) {
    assert.equal(varSourceTokenDeps(probe, "light"), null, `${probe} 不是依赖表项`);
  }
});

test("M3.1：固定色 classic / character 分支不串用——trend-up 前景取 BASE_COLORS 对应分支且依赖为空", () => {
  const roles = ROLE_CATALOG.filter((role) => ["summary.trend-up", "summary.trend-down"].includes(role.id));
  const character = m31Run({ skinId: "chatgpt", roles });
  const classic = m31Run({ skinId: "classic", roles });
  const byId = (result) => new Map(result.entries.map((entry) => [entry.roleId, entry]));
  // 评估器输出规范大写 HEX；BASE_COLORS 目录数据为小写——按大小写无关比较
  const upper = (value) => value.toUpperCase();
  assert.equal(
    upper(byId(character).get("summary.trend-up").effectiveForeground),
    BASE_COLORS.character.light["--green"].toUpperCase(),
  );
  assert.equal(
    upper(byId(classic).get("summary.trend-up").effectiveForeground),
    BASE_COLORS.classic.light["--green"].toUpperCase(),
  );
  assert.equal(
    upper(byId(character).get("summary.trend-down").effectiveForeground),
    BASE_COLORS.character.light["--red"].toUpperCase(),
  );
  assert.equal(
    upper(byId(classic).get("summary.trend-down").effectiveForeground),
    BASE_COLORS.classic.light["--red"].toUpperCase(),
  );
  assert.deepEqual(
    byId(character).get("summary.trend-up").foregroundTokens,
    [],
    "固定色前景无 token 依赖（M2 固定色冲突判定的依据）",
  );
  // 深色分支同步核对
  const dark = m31Run({ skinId: "chatgpt", mode: "dark", roles });
  assert.equal(
    upper(byId(dark).get("summary.trend-up").effectiveForeground),
    BASE_COLORS.character.dark["--green"].toUpperCase(),
  );
});

test("M3.1：样式表别名透传——--panel/--track/--toggle-selected 解析为恒等目标，不另立公式", () => {
  const roles = [
    m31Role({ id: "alias.panel", background: { kind: "solid", color: { kind: "var", name: "--panel" } } }),
    m31Role({ id: "alias.track", foreground: { kind: "var", name: "--track" } }),
    m31Role({ id: "alias.toggle", foreground: { kind: "var", name: "--toggle-selected" } }),
  ];
  const result = m31Run({ roles });
  const byId = new Map(result.entries.map((entry) => [entry.roleId, entry]));
  assert.equal(byId.get("alias.panel").effectiveBackground, M31_TOKENS.panelBackground, "--panel ≡ --neo-surface");
  assert.deepEqual(
    byId.get("alias.track").foregroundTokens,
    ["pageBackground", "panelShadow"],
    "--track ≡ --ceramic-well（light 喂入）",
  );
  assert.deepEqual(byId.get("alias.toggle").foregroundTokens, ["accent"], "--toggle-selected ≡ --blue");
  // 别名值与直接引用目标变量完全一致
  const direct = m31Run({
    roles: [
      m31Role({ id: "direct.track", foreground: { kind: "var", name: "--ceramic-well" } }),
      m31Role({ id: "direct.toggle", foreground: { kind: "var", name: "--blue" } }),
    ],
  });
  const directById = new Map(direct.entries.map((entry) => [entry.roleId, entry]));
  assert.equal(byId.get("alias.track").effectiveForeground, directById.get("direct.track").effectiveForeground);
  assert.equal(byId.get("alias.toggle").effectiveForeground, directById.get("direct.toggle").effectiveForeground);
});

test("M3.1：依赖表与 M1.1 派生实现全等——以 derive 为 oracle 逐变量校验敏感 token 集合", () => {
  const derivedVars = [
    "--bg",
    "--neo-surface",
    "--control",
    "--neo-edge",
    "--line",
    "--ink",
    "--muted",
    "--chart-text",
    "--chart-line",
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
  ];
  const fixedVars = ["--green", "--red"];
  const declaredOf = (tokens, mode) => new Map(derivePaletteDeclarationsFromTokens(tokens, mode));
  const black = Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#000000"]));
  const white = Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#FFFFFF"]));
  for (const mode of ["light", "dark"]) {
    const baseline = declaredOf(M31_TOKENS, mode);
    const allBlack = declaredOf(black, mode);
    const allWhite = declaredOf(white, mode);
    const valueOfVar = (map, name) => map.get(name);
    for (const name of derivedVars) {
      // 全黑/全白两极端下值不同的变量必然派生自至少一个 token；逐 token 二分找敏感集合
      const sensitive = [];
      for (const key of PALETTE_TOKEN_KEYS) {
        const withBlack = declaredOf({ ...M31_TOKENS, [key]: "#000000" }, mode).get(name);
        const withWhite = declaredOf({ ...M31_TOKENS, [key]: "#FFFFFF" }, mode).get(name);
        if (withBlack !== withWhite) sensitive.push(key);
      }
      // oracle 侧：极端正反两方向至少确认该变量确实派生自 token（全黑≠全白）
      const extremeSensitive = valueOfVar(allBlack, name) !== valueOfVar(allWhite, name);
      const claimed = varSourceTokenDeps(name, mode);
      assert.ok(Array.isArray(claimed), `${name} 必须在依赖表中`);
      if (!extremeSensitive) {
        assert.deepEqual(sensitive, [], `${name} 在 M1.1 下不随 token 变化，依赖表应为空`);
        assert.deepEqual(claimed, [], `${name} 依赖表应为空`);
        continue;
      }
      assert.deepEqual(
        sensitive.sort(),
        [...claimed].sort(),
        `${name}（${mode}）敏感 token 集合必须与依赖表全等（防两表漂移）`,
      );
      // 声明值确实存在且随基线可取
      assert.ok(baseline.get(name), `${name} 应在 M1.1 声明中（基线十二键齐全）`);
    }
    for (const name of fixedVars) {
      assert.deepEqual(varSourceTokenDeps(name, mode), [], `${name} 是固定色，依赖必须为空`);
      assert.equal(declaredOf(M31_TOKENS, mode).get(name), undefined, `${name} 不来自 M1.1 声明`);
    }
  }
});

test("M3.1：M0 输入校验——坏 token / 未知皮肤 / 非法模式 / 缺 policy 显式拒绝", () => {
  assert.throws(() => m31Run({ tokens: { ...M31_TOKENS, textPrimary: "zzz" } }), /M0 校验/, "坏 HEX 拒绝");
  assert.throws(() => m31Run({ tokens: { pageBackground: "#FFFFFF" } }), /M0 校验/, "缺键拒绝");
  assert.throws(() => m31Run({ skinId: "nope" }), /未知皮肤/);
  assert.throws(() => m31Run({ mode: "sepia" }), /未知模式/);
  assert.throws(() => m31Run({ policy: null }), /policy/);
  assert.throws(() => m31Run({ roles: "not-an-array" }), /roleCatalog/);
});

test("M3.1：官方十套调色板全模式冒烟——结构完整、必要角色无 unmeasured、比值可复算", () => {
  for (const skinId of ["chatgpt", "grok", "claude", "gemini", "deepseek"]) {
    for (const mode of ["light", "dark"]) {
      // 官方 paletteTokens 是样式表原值（允许小写）；候选契约为大写——调用方先归一
      const raw = paletteTokens(skinId, mode);
      assert.ok(raw, `${skinId}/${mode} 官方调色板应存在`);
      const tokens = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value).toUpperCase()]));
      const result = evaluatePalette({ skinId, mode, tokens, roleCatalog: ROLE_CATALOG, policy: M31_POLICY });
      assert.equal(result.entries.length, ROLE_CATALOG.length);
      for (const entry of result.entries) {
        if (entry.status === "pass" || entry.status === "fail") {
          assert.ok(Number.isFinite(entry.ratio) && entry.ratio >= 1, `${skinId}/${mode} ${entry.roleId} 比值非法`);
        }
        if (entry.required) {
          assert.notEqual(
            entry.status,
            "unmeasured",
            `${skinId}/${mode} ${entry.roleId} 必要角色缺测：${entry.methodDetail}`,
          );
        }
      }
    }
  }
});

test("M3.1：模块纯度——只依赖 M0/M1/官方 skins 模块，零 I/O、零 DOM、零随机零时间", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/evaluate.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s+[^;]+?from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...imports].sort(), [
    "../../public/skins.js",
    "./color-math.mjs",
    "./contracts.mjs",
    "./roles.mjs",
  ]);
  for (const banned of [
    "document",
    "window",
    "Math.random",
    "Date.now",
    "process.",
    "readFileSync",
    "writeFileSync",
    "fetch(",
  ]) {
    assert.ok(!source.includes(banned), `evaluate 模块不得出现 ${banned}`);
  }
});

// ============================================================================
// M3.2 浏览器实际色源与背景测量（browser-measure.mjs）
//
// 三层验证，对应卡面"读取计算样式 + 无前景背景截图 + 像素检查"的固定路径：
//   A. 页内源字符串单测（node:vm + DOM 替身）——观察器字段/调用原函数/不改参数、
//      颜色解析双哨兵、扫描区域页坐标换算与 scale 补偿、图像比对、文字隐藏与
//      恢复 round-trip（不改变 color）。
//   B. 编排单测（脚本化假 page）——分派顺序、记录十字段（过 M0 契约自检）、
//      最差样本汇总、alpha 合成口径、恢复核验、canvas 路径、不可隔离出口、
//      输入校验与 ENVIRONMENT_BLOCKED 降级（不伪造通过）。
//   C. 真实浏览器集成（M0.4 fixture + Edge）——纯色/渐变/placeholder/聚光开关/
//      Canvas 标签五样例、raw token 达标但真实叠加必须失败、截图前后几何与
//      偏好不变；浏览器不可用时降级为 ENVIRONMENT_BLOCKED 断言。
// 页内源与真实 Playwright 共用同一份字符串（skinProbe 标记），替身只替换
// 浏览器 API，不复制实现。
// ============================================================================

const M32_ROLES = new Map(ROLE_CATALOG.map((role) => [role.id, role]));
const m32Role = (id, overrides = {}) => {
  const role = M32_ROLES.get(id);
  if (!role) throw new TypeError(`测试引用了目录外角色：${id}`);
  return { ...role, ...overrides };
};
const M32_RECORD_FIELDS = Object.freeze([
  "candidateId",
  "evidence",
  "method",
  "mode",
  "ratio",
  "reason",
  "result",
  "roleId",
  "stateId",
  "threshold",
]);
/** vm 里产生的数组/对象带另一个 Array/Object 原型：深度断言前转回宿主原型。 */
const hostValue = (value) => JSON.parse(JSON.stringify(value));

/** CSS 颜色解析替身：仅接受合法值（浏览器语义——非法值静默保持上一 fillStyle）。 */
const stubParseCssColor = (value) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    const channels =
      digits.length === 3
        ? [...digits].map((digit) => Number.parseInt(digit + digit, 16) / 255)
        : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].map((pair) => Number.parseInt(pair, 16) / 255);
    return [...channels, 1];
  }
  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (functional) {
    const parts = functional[1].split(",").map((part) => Number.parseFloat(part));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => Number.isNaN(part))) return null;
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1];
  }
  return null;
};

// --- A. 页内源单测（node:vm + DOM 替身） -------------------------------------

/** 观察器替身：2d 上下文桩，原方法记录调用（证明观察器调用原函数）。 */
function createObserverStubDom() {
  const calls = [];
  class StubRenderingContext {
    constructor(canvas) {
      this.canvas = canvas;
      this.fillStyle = "#000000";
      this.strokeStyle = "#000000";
      this.lineWidth = 1;
      this.globalAlpha = 1;
      this.globalCompositeOperation = "source-over";
      this.font = "10px sans-serif";
      this.textAlign = "start";
    }
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    }
    measureText(text) {
      return {
        width: String(text).length * 6,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 2,
      };
    }
    fillText(...args) {
      calls.push({ method: "fillText", args });
    }
    strokeText(...args) {
      calls.push({ method: "strokeText", args });
    }
    stroke() {
      calls.push({ method: "stroke", args: [] });
    }
    fill() {
      calls.push({ method: "fill", args: [] });
    }
    fillRect(...args) {
      calls.push({ method: "fillRect", args });
    }
  }
  return { calls, sandbox: { window: { CanvasRenderingContext2D: StubRenderingContext } } };
}

test("M3.2：观察器记录卡面字段、调用原函数且不改绘图参数，安装幂等", () => {
  const { calls, sandbox } = createObserverStubDom();
  // 替身构造器由宿主定义、经 sandbox 暴露给页内源：实例与补丁共享同一原型
  const StubCtx = sandbox.window.CanvasRenderingContext2D;
  assert.equal(runInNewContext(buildColorObserverSource(), sandbox), "installed", "首次安装返回 installed");

  const canvas = { id: "timelineChart", width: 40, height: 20 };
  const ctx = new StubCtx(canvas);
  const drawArgs = ["L1", 5, 12];
  const fillArgs = [0, 0, 40, 20];
  ctx.fillStyle = "#abcdef";
  ctx.fillText(...drawArgs);
  ctx.fillRect(...fillArgs);
  ctx.strokeText("S", 1, 2);
  ctx.stroke();
  ctx.fill();

  const records = sandbox.window.__skinPaletteColorObserver.records;
  assert.equal(records.length, 5, "五种绘制各记录一条（卡面四法 + fillRect）");
  for (const [eventSequence, record] of records.entries()) {
    assert.equal(record.eventSequence, eventSequence, "受监视调用按观察器实例单调编号");
    assert.equal(record.canvasRef, canvas, "记录指向绘制所在画布");
    assert.equal(record.canvasId, "timelineChart");
    assert.equal(record.frame, 0);
    assert.equal(record.fillStyle, "#abcdef");
    assert.equal(record.strokeStyle, "#000000");
    assert.equal(record.lineWidth, 1);
    assert.equal(record.alpha, 1);
    assert.equal(record.composite, "source-over");
    assert.equal(record.font, "10px sans-serif");
    assert.equal(record.textAlign, "start");
    assert.deepEqual(hostValue(record.transform), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  }
  const [text, rect, strokeText, stroke, fill] = records;
  assert.equal(text.method, "fillText");
  assert.equal(text.text, "L1");
  assert.equal(text.x, 5);
  assert.equal(text.y, 12);
  assert.equal(text.measured.width, 12, "measureText 宽高 ascent/descent 均被记录");
  assert.equal(text.measured.ascent, 8);
  assert.equal(rect.method, "fillRect");
  assert.deepEqual(hostValue(rect.rectArgs), fillArgs);
  assert.equal(strokeText.method, "strokeText");
  assert.equal(stroke.method, "stroke");
  assert.equal(fill.method, "fill");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["fillText", "fillRect", "strokeText", "stroke", "fill"],
    "观察器必须调用原函数，不是拦截后丢弃",
  );
  assert.deepEqual(drawArgs, ["L1", 5, 12], "调用方参数数组内容不变");
  assert.deepEqual(fillArgs, [0, 0, 40, 20]);

  const errorCtx = new StubCtx(canvas);
  errorCtx.strokeStyle = "#101010";
  errorCtx.lineWidth = 2.5;
  errorCtx.globalAlpha = 0.75;
  errorCtx.globalCompositeOperation = "multiply";
  errorCtx.measureText = () => {
    throw new Error("measureText failed");
  };
  errorCtx.fillText("broken", 3, 4);
  const errorRecord = records.at(-1);
  assert.equal(errorRecord.eventSequence, 5, "观察错误沿用本次调用序号");
  assert.equal(errorRecord.canvasId, "timelineChart");
  assert.equal(errorRecord.frame, 0);
  assert.equal(errorRecord.strokeStyle, "#101010");
  assert.equal(errorRecord.lineWidth, 2.5);
  assert.equal(errorRecord.alpha, 0.75);
  assert.equal(errorRecord.composite, "multiply");
  assert.deepEqual(hostValue(errorRecord.transform), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.match(errorRecord.observationError, /measureText failed/);

  const other = new StubCtx({ width: 1, height: 1 });
  other.fillRect(0, 0, 1, 1);
  assert.equal(sandbox.window.__skinPaletteColorObserver.records.length, 7, "补丁在原型上：新实例同样被观察");
  assert.equal(records.at(-1).eventSequence, 6, "观察错误后序号仍单调递增");
  assert.equal(runInNewContext(buildColorObserverSource(), sandbox), "already-installed", "重复安装幂等");
});

/** 颜色解析替身 DOM：1×1 画布，fillStyle 遵循浏览器"非法值保持上一值"语义。 */
function createColorParseStubDom() {
  class StubCanvas {
    constructor() {
      this.width = 1;
      this.height = 1;
      this._pixel = new Uint8ClampedArray(4);
      this._ctx = null;
    }
    getContext() {
      if (!this._ctx) {
        const canvas = this;
        this._ctx = {
          _fillStyle: "#000000",
          get fillStyle() {
            return this._fillStyle;
          },
          set fillStyle(value) {
            if (stubParseCssColor(value)) this._fillStyle = value;
          },
          clearRect() {
            canvas._pixel.set([0, 0, 0, 0]);
          },
          fillRect() {
            const rgba = stubParseCssColor(this._fillStyle);
            if (rgba) canvas._pixel.set([rgba[0] * 255, rgba[1] * 255, rgba[2] * 255, rgba[3] * 255]);
          },
          getImageData() {
            return { data: canvas._pixel };
          },
        };
      }
      return this._ctx;
    }
  }
  return { window: {}, document: { createElement: () => new StubCanvas() } };
}

test("M3.2：颜色解析用浏览器自身 canvas——合法值取真值，非法值不得静默沿用上一 fillStyle", async () => {
  const dom = createColorParseStubDom();
  const hex = runInNewContext(buildProbeSource("color-parse", "#123456"), dom);
  assert.equal(hex.ok, true);
  assert.deepEqual(hostValue(hex.rgb), [18 / 255, 52 / 255, 86 / 255]);
  assert.equal(hex.alpha, 1);

  const rgba = runInNewContext(buildProbeSource("color-parse", "rgba(255, 0, 0, 0.5)"), dom);
  assert.equal(rgba.ok, true);
  assert.deepEqual(hostValue(rgba.rgb), [1, 0, 0]);
  // getImageData 回读是 8 位量化（真实浏览器同样 127.5→128），不是 Node 解析精度
  assert.ok(Math.abs(rgba.alpha - 0.5) < 1 / 255, `alpha 通道由浏览器 canvas 给出（实得 ${rgba.alpha}）`);

  const invalid = runInNewContext(buildProbeSource("color-parse", "totally-not-a-color"), dom);
  assert.equal(invalid.ok, false, "双哨兵检测：非法 CSS 颜色必须被拒绝");
  assert.match(invalid.reason, /拒绝|未更新/);
  assert.equal(invalid.rgb, undefined, "拒绝时不得给出任何颜色数值");
});

/** PNG 替身：Image.decode 按构造顺序产出预置位图，canvas 提供 getImageData 切片。 */
function createPngStubDom({ width, height, fill, images = [{ width, height, fill }] }) {
  const specs = images.map((image) => {
    const buffer = new Uint8ClampedArray(image.width * image.height * 4);
    for (let index = 0; index < image.width * image.height; index += 1) {
      buffer.set(image.fill(index % image.width, Math.floor(index / image.width)), index * 4);
    }
    return { ...image, buffer };
  });
  let imageIndex = 0;
  class StubImage {
    constructor() {
      this.__spec = specs[Math.min(imageIndex, specs.length - 1)];
      imageIndex += 1;
      this.__buffer = this.__spec.buffer;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }
    set src(value) {
      this.__src = value;
    }
    async decode() {
      this.naturalWidth = this.__spec.width;
      this.naturalHeight = this.__spec.height;
    }
  }
  class StubCanvas {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.__buffer = null;
    }
    getContext() {
      const canvas = this;
      return {
        drawImage(image) {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.__buffer = image.__buffer;
        },
        getImageData(x, y, w, h) {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row += 1) {
            const from = ((y + row) * canvas.width + x) * 4;
            data.set(canvas.__buffer.subarray(from, from + w * 4), row * w * 4);
          }
          return { data, width: w, height: h };
        },
      };
    }
  }
  return { sandbox: { window: {}, document: { createElement: () => new StubCanvas() }, Image: StubImage } };
}

test("M3.2：扫描源按页坐标换算区域并回报原点，越界区域被剔除", async () => {
  // 图像与 clip 同尺寸（scale=css）：页坐标 → 图像坐标只差 clip 原点
  const dom = createPngStubDom({ width: 20, height: 10, fill: (x, y) => [x * 4, y * 8, 0, 255] });
  const clip = { x: 10, y: 5, width: 20, height: 10 };
  const regions = [
    { id: "inside", x: 12, y: 7, width: 4, height: 2 },
    { id: "outside", x: 500, y: 500, width: 4, height: 2 },
  ];
  const scan = await runInNewContext(buildProbeSource("scan", "png-base64", regions, clip), dom.sandbox);
  assert.equal(scan.width, 20);
  assert.equal(scan.height, 10);
  assert.deepEqual(hostValue(scan.scale), { x: 1, y: 1 }, "scale=css 时 1 图像像素 = 1 CSS 像素");
  const [inside, outside] = scan.regions;
  assert.equal(inside.columns, 4);
  assert.equal(inside.rows, 2);
  assert.deepEqual(hostValue(inside.origin), { x: 2, y: 2 }, "原点是区域在图像内的偏移（页坐标 − clip 原点）");
  assert.deepEqual(
    [...inside.pixels.slice(0, 8)],
    [8, 16, 0, 255, 12, 16, 0, 255],
    "像素取自对应坐标（页 12,13 → 图像 2,3）",
  );
  assert.equal(outside.columns, 0, "完全越出 clip 的区域不产生样本");
  assert.equal(outside.pixels.length, 0);
});

test("M3.2：扫描源在图像像素与 CSS 像素不同比例时按 scale 补偿", async () => {
  const dom = createPngStubDom({ width: 40, height: 20, fill: (x, y) => [x, y, 0, 255] });
  const scan = await runInNewContext(
    buildProbeSource("scan", "png", [{ id: "r0", x: 2, y: 1, width: 4, height: 2 }], {
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    }),
    dom.sandbox,
  );
  assert.deepEqual(hostValue(scan.scale), { x: 2, y: 2 }, "自然宽度 / clip 宽度即 scale");
  assert.equal(scan.regions[0].columns, 8, "CSS 4px 在 2× 图像上取 8 列");
  assert.equal(scan.regions[0].rows, 4);
  assert.deepEqual(hostValue(scan.regions[0].origin), { x: 4, y: 2 });
});

test("M3.2：图像比对源逐像素比较并返回完整差异边界", async () => {
  const same = createPngStubDom({ width: 4, height: 2, fill: () => [10, 20, 30, 255] });
  const identical = await runInNewContext(buildProbeSource("compare-images", "left", "right"), same.sandbox);
  assert.deepEqual(hostValue(identical), {
    identical: true,
    width: 4,
    height: 2,
    differingPixels: 0,
    maxChannelDelta: 0,
    bbox: null,
  });

  const base = [10, 20, 30, 255];
  const changed = (x, y) => (x === 0 && y === 0) || (x === 3 && y === 2);
  const differing = createPngStubDom({
    images: [
      { width: 4, height: 3, fill: () => base },
      { width: 4, height: 3, fill: (x, y) => (changed(x, y) ? [12, 20, 30, 255] : base) },
    ],
  });
  const result = await runInNewContext(buildProbeSource("compare-images", "left", "right"), differing.sandbox);
  assert.deepEqual(hostValue(result), {
    identical: false,
    width: 4,
    height: 3,
    differingPixels: 2,
    maxChannelDelta: 2,
    bbox: { x: 0, y: 0, width: 4, height: 3 },
  });

  const sized = createPngStubDom({
    images: [
      { width: 4, height: 2, fill: () => [10, 20, 30, 255] },
      { width: 3, height: 2, fill: () => [10, 20, 30, 255] },
    ],
  });
  const mismatch = await runInNewContext(buildProbeSource("compare-images", "left", "right"), sized.sandbox);
  assert.deepEqual(hostValue(mismatch), {
    identical: false,
    reason: "尺寸不同",
    width: null,
    height: null,
    differingPixels: -1,
    maxChannelDelta: -1,
    bbox: null,
  });
});

/** 元素替身 DOM：style 模型 + getComputedStyle 合并 + Range + instanceof 构造器。 */
function createElementStubDom() {
  // 构造器由宿主定义后放进 sandbox：宿主 new 出来的实例与页内 instanceof 判断同原型
  class StubHTMLInputElement {}
  class StubHTMLTextAreaElement {}
  class StubSVGElement {}
  const elements = [];
  const sandbox = {
    // 窗口滚动替身：scroll-begin/scroll-restore 读 scrollX/scrollY 并调 scrollTo
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      scrollTo(x, y) {
        this.scrollX = x;
        this.scrollY = y;
      },
      scrollBy(x, y) {
        this.scrollTo(this.scrollX + x, this.scrollY + y);
      },
    },
    HTMLInputElement: StubHTMLInputElement,
    HTMLTextAreaElement: StubHTMLTextAreaElement,
    SVGElement: StubSVGElement,
  };
  let hitTest = () => null;
  const classes = { input: StubHTMLInputElement, textarea: StubHTMLTextAreaElement, svg: StubSVGElement };

  const makeStyle = (initial = {}, onChange = () => {}) => {
    const props = new Map(Object.entries(initial));
    const cssText = () =>
      [...props]
        .filter(([property]) => !property.endsWith("!priority"))
        .map(([property, value]) => {
          const priority = props.get(`${property}!priority`);
          return `${property}: ${value}${priority ? ` !${priority}` : ""};`;
        })
        .join(" ");
    return {
      get cssText() {
        return cssText();
      },
      getPropertyValue(property) {
        return props.has(property) ? props.get(property) : "";
      },
      getPropertyPriority(property) {
        return props.has(`${property}!priority`) ? props.get(`${property}!priority`) : "";
      },
      setProperty(property, value, priority = "") {
        props.set(property, value);
        if (priority) props.set(`${property}!priority`, priority);
        else props.delete(`${property}!priority`);
        onChange(cssText());
      },
      removeProperty(property) {
        props.delete(property);
        props.delete(`${property}!priority`);
        onChange(cssText());
      },
    };
  };

  const COMPUTED_DEFAULTS = {
    color: "rgb(0, 0, 0)",
    fontSize: "14px",
    fontWeight: "400",
    opacity: "1",
    filter: "none",
    mixBlendMode: "normal",
    backdropFilter: "none",
    textShadow: "none",
    boxShadow: "none",
    textDecorationLine: "none",
    webkitTextFillColor: "",
    webkitTextStrokeWidth: "0px",
    textEmphasisStyle: "none",
    visibility: "visible",
    display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    clipPath: "none",
    maskImage: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    overflowX: "visible",
    overflowY: "visible",
    borderTopLeftRadius: "0px",
    borderTopRightRadius: "0px",
    borderBottomRightRadius: "0px",
    borderBottomLeftRadius: "0px",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
  };
  const PROPERTY_OF = {
    color: "color",
    fontSize: "font-size",
    fontWeight: "font-weight",
    opacity: "opacity",
    textShadow: "text-shadow",
    boxShadow: "box-shadow",
    textDecorationLine: "text-decoration-line",
    webkitTextFillColor: "-webkit-text-fill-color",
    visibility: "visibility",
    display: "display",
    backgroundColor: "background-color",
    backgroundImage: "background-image",
    overflowX: "overflow-x",
    overflowY: "overflow-y",
  };
  const pseudoTextFill = (element) =>
    element.style.getPropertyValue("-webkit-text-fill-color") || (element._pseudo?.textFillColor ?? "");
  /** 继承属性：自身内联没有就沿 parentElement 往上找（真实 CSS 的继承语义）。 */
  const inheritedValue = (element, property, fallback) => {
    for (let current = element; current; current = current.parentElement) {
      const own = current.style.getPropertyValue(property);
      if (own) return own;
    }
    return fallback;
  };

  const styleNodes = [];
  const head = {
    appendChild(node) {
      node.parentNode = this;
      node.isConnected = true;
      const match = /^(.+)\{visibility:hidden!important\}$/.exec(node.textContent);
      const ruleStyle = makeStyle(match ? { visibility: "hidden" } : {});
      if (match) ruleStyle.setProperty("visibility", "hidden", "important");
      node.sheet = {
        cssRules: match ? [{ selectorText: match[1], style: ruleStyle }] : [],
        deleteRule(index) {
          this.cssRules.splice(index, 1);
        },
      };
      styleNodes.push(node);
      return node;
    },
    removeChild(node) {
      node.parentNode = null;
      node.isConnected = false;
      return node;
    },
  };
  const document = {
    activeElement: null,
    head,
    documentElement: head,
    createElement(tagName) {
      if (String(tagName).toLowerCase() !== "style") return { tagName: String(tagName).toUpperCase() };
      return {
        tagName: "STYLE",
        textContent: "",
        isConnected: false,
        parentNode: null,
        sheet: null,
        remove() {
          this.parentNode?.removeChild(this);
        },
      };
    },
    querySelectorAll(selector) {
      if (selector === "input::placeholder") {
        throw new TypeError("Failed to execute 'querySelectorAll': 'input::placeholder' is not a valid selector.");
      }
      // 真实浏览器语义："*" 命中文档内所有元素（滚动会话按它枚举候选容器）
      if (selector === "*") return elements;
      return elements.filter((element) => element._selector === selector);
    },
    createRange() {
      return {
        _target: null,
        selectNodeContents(element) {
          this._target = element;
        },
        selectNode(node) {
          this._target = node;
        },
        getClientRects() {
          return (this._target?._textRects ?? []).map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }));
        },
      };
    },
    elementFromPoint(x, y) {
      return hitTest(x, y);
    },
  };
  const getComputedStyle = (element, pseudo = null) => {
    if (pseudo) {
      const overlay = element._pseudo ?? {};
      return {
        color: overlay.color ?? COMPUTED_DEFAULTS.color,
        opacity: overlay.opacity ?? COMPUTED_DEFAULTS.opacity,
        fontSize: overlay.fontSize ?? COMPUTED_DEFAULTS.fontSize,
        webkitTextFillColor: pseudoTextFill(element),
        content: overlay.content ?? "normal",
      };
    }
    const computed = { ...COMPUTED_DEFAULTS, ...element._computed };
    // color / text-shadow / -webkit-text-fill-color 都是继承属性：替身必须沿
    // parentElement 往上找，否则"宿主写 transparent、子节点继承"读不出来，
    // 也就测不出"子节点自带填充会覆盖继承"这个关键分支。
    computed.color = inheritedValue(element, "color", COMPUTED_DEFAULTS.color);
    computed.textShadow = inheritedValue(element, "text-shadow", COMPUTED_DEFAULTS.textShadow);
    computed.webkitTextFillColor = inheritedValue(element, "-webkit-text-fill-color", "");
    for (const [key, property] of Object.entries(PROPERTY_OF)) {
      if (key === "color" || key === "textShadow" || key === "webkitTextFillColor") continue;
      const inline = element.style.getPropertyValue(property);
      if (
        inline &&
        (element.style.getPropertyPriority(property) === "important" ||
          element._computedPriorities?.[key] !== "important")
      ) {
        computed[key] = inline;
      }
    }
    return computed;
  };

  const build = (spec) => {
    const element = spec.field ? new classes.input() : spec.svg ? new classes.svg() : { nodeType: 1 };
    const attributes = new Map(Object.entries(spec.attributes ?? {}));
    const style = makeStyle(spec.inline ?? {}, (cssText) => attributes.set("style", cssText));
    if (!attributes.has("style") && style.cssText) attributes.set("style", style.cssText);
    Object.assign(element, {
      nodeType: 1,
      tagName: spec.tag ?? "DIV",
      id: spec.id ?? "",
      className: spec.className ?? "",
      namespaceURI: spec.namespaceURI ?? "http://www.w3.org/1999/xhtml",
      isContentEditable: spec.isContentEditable ?? false,
      shadowRoot: spec.shadowRoot ?? null,
      type: spec.type ?? (spec.field ? "text" : ""),
      _selector: spec.selector,
      _rect: spec.rect,
      _textRects: spec.textRects ?? [spec.rect],
      _computed: spec.computed ?? {},
      _computedPriorities: spec.computedPriorities ?? {},
      _pseudo: spec.pseudo ?? null,
      placeholder: spec.placeholder ?? "",
      value: spec.value ?? "",
      clientLeft: spec.clientLeft ?? 0,
      clientTop: spec.clientTop ?? 0,
      clientWidth: spec.clientWidth ?? spec.rect.width,
      clientHeight: spec.clientHeight ?? spec.rect.height,
      parentElement: spec.parentElement ?? null,
      style,
      focus() {
        document.activeElement = this;
      },
      hasAttribute(name) {
        if (name === "id") return Boolean(this.id);
        if (name === "class") return Boolean(this.className);
        return attributes.has(name);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      getBoundingClientRect() {
        const rect = this._rect;
        return {
          ...rect,
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height,
        };
      },
      scrollIntoView() {},
      getAttribute(name) {
        if (name === "id") return spec.id ?? null;
        if (name === "class") return spec.className ?? null;
        return attributes.has(name) ? attributes.get(name) : null;
      },
      contains(target) {
        return target === this || this.querySelectorAll("*").includes(target);
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
    });
    elements.push(element);
    // 子树：真实 DOM 里 querySelectorAll("*") 只返回后代（不含自身），
    // 有直接文本的元素才是会画字的元素。这两点都要在替身里如实建模。
    const descendants = (spec.descendants ?? []).map((child) => build({ ...child, parentElement: element }));
    element._descendants = descendants;
    element.children = descendants;
    element.childElementCount = descendants.length;
    element.childNodes = spec.childNodes ?? (spec.text ? [{ nodeType: 3, textContent: spec.text }] : []);
    element.textContent =
      element.childNodes.map((child) => child.textContent ?? "").join("") +
      descendants.map((child) => child.textContent ?? "").join("");
    element.querySelectorAll = (selector) => {
      const all = descendants.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return all;
      if (selector.startsWith(".")) {
        const className = selector.slice(1);
        return all.filter((child) => String(child.className).split(/\s+/).includes(className));
      }
      if (selector.startsWith("#")) return all.filter((child) => child.id === selector.slice(1));
      return [];
    };
    return element;
  };
  // document / getComputedStyle / 构造器都挂在同一个 sandbox 上：页内源以裸全局访问
  sandbox.document = document;
  sandbox.getComputedStyle = getComputedStyle;
  /**
   * 把 target 换成 replacement（模拟框架重建节点）：build() 会把新元素追加到末尾，
   * 先摘掉那一份再顶替原位，集合长度不变、位次换成新对象。
   */
  const replace = (target, replacement) => {
    const appended = elements.indexOf(replacement);
    if (appended >= 0) elements.splice(appended, 1);
    const at = elements.indexOf(target);
    if (at >= 0) elements[at] = replacement;
  };
  /** 只换宿主里的某个子节点（宿主对象保持不变）：模拟 th 里的 button/span 被重建。 */
  const replaceIn = (parent, target, replacement) => {
    const appended = elements.indexOf(replacement);
    if (appended >= 0) elements.splice(appended, 1);
    const at = parent._descendants.indexOf(target);
    if (at >= 0) parent._descendants[at] = replacement;
  };
  return {
    sandbox,
    build,
    classes,
    elements,
    styleNodes,
    replace,
    replaceIn,
    setHitTest(handler) {
      hitTest = handler;
    },
  };
}

/** Actual production probe sources with a screenshot crop tied to the requested CSS clip. */
function createActualSurfacePage(dom, { pixels, scanWidth, scanHeight, mutateScan }) {
  const evaluations = [];
  const screenshots = [];
  const stateScreenshots = [];
  const fullPageFixture = createStableFullPageNodePage();
  let scanImage = null;
  const page = {
    evaluations,
    screenshots,
    async evaluate(source, argument) {
      if (typeof source === "function") return fullPageFixture.page.evaluate(source, argument);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      evaluations.push(tag);
      if (tag === "spotlight-stability") {
        return { stable: true, reason: null, budgetMs: 500, waitedMs: 0, frameCount: 1, transitionsWaited: 0 };
      }
      if (tag === "color-parse") return { ok: true, rgb: [0, 0, 0], alpha: 1, readBack: "#000000" };
      if (tag === "compare-images") return { identical: true, differingPixels: 0, maxChannelDelta: 0 };
      if (tag === "scan") {
        const scanSandbox = {
          ...dom.sandbox,
          document: { ...dom.sandbox.document, createElement: scanImage.sandbox.document.createElement },
          Image: scanImage.sandbox.Image,
        };
        const scan = await runInNewContext(String(source), scanSandbox);
        return mutateScan ? mutateScan(hostValue(scan)) : scan;
      }
      return runInNewContext(String(source), dom.sandbox);
    },
    async screenshot(options) {
      if (options?.fullPage === true || options?.fullPage === false) {
        stateScreenshots.push(options);
        return fullPageFixture.page.screenshot(options);
      }
      screenshots.push(options.clip);
      const coreClip = Math.abs(options.clip.width - 3) < 1e-6 && Math.abs(options.clip.height - 3) < 1e-6;
      const width = scanWidth ?? (coreClip ? 3 : 7);
      const height = scanHeight ?? (coreClip ? 3 : 7);
      const scaleX = width / (coreClip ? 3 : 7);
      const scaleY = height / (coreClip ? 3 : 7);
      scanImage = createPngStubDom({
        width,
        height,
        fill: (x, y) => {
          const column = (coreClip ? 2 : 0) + Math.floor(x / scaleX);
          const row = (coreClip ? 2 : 0) + Math.floor(y / scaleY);
          return pixels[row]?.[column] ?? [0, 0, 0, 255];
        },
      });
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
  };
  return { page, evaluations, screenshots, stateScreenshots, fullPageFixture };
}

const d8f2PixelGrid = (core, edge) =>
  Array.from({ length: 7 }, (_, y) =>
    Array.from({ length: 7 }, (_, x) => [...(x >= 2 && x <= 4 && y >= 2 && y <= 4 ? core : edge), 255]),
  );

function createD8f2Sample({
  pixels,
  scanWidth,
  scanHeight,
  mutateScan,
  rect = { x: 10.25, y: 20.5, width: 7, height: 7 },
  clientWidth = 7,
  clientHeight = 7,
  clientLeft = 0,
  clientTop = 0,
  occluded = false,
  includeHiddenMatch = false,
  roleId = "badge.record",
  stateId = "metric-record-visible",
}) {
  const dom = createElementStubDom();
  const target = dom.build({
    selector: ".badge",
    id: "record-badge",
    className: "metric-new",
    rect,
    clientLeft,
    clientTop,
    clientWidth,
    clientHeight,
    inline: {
      "background-color": "rgb(0, 0, 0)",
      "box-shadow": "0 0 2px rgb(0, 0, 0)",
      "box-shadow!priority": "important",
    },
  });
  const hiddenTarget = includeHiddenMatch
    ? dom.build({
        selector: ".badge",
        id: "hidden-record-badge",
        className: "metric-new",
        rect: { x: 30, y: 40, width: 0, height: 0 },
        clientWidth: 0,
        clientHeight: 0,
        computed: { display: "none" },
      })
    : null;
  const overlay = occluded ? dom.build({ selector: ".overlay", id: "overlay", className: "overlay", rect }) : null;
  dom.setHitTest(() => overlay ?? target);
  dom.sandbox.window.scrollTo(11, 13);
  target.scrollIntoView = () => dom.sandbox.window.scrollTo(41, 43);
  const harness = createActualSurfacePage(dom, { pixels, scanWidth, scanHeight, mutateScan });
  const role = m32Role(roleId, {
    selector: ".badge",
    ...(roleId === "spotlight.tinted-surface"
      ? {
          kind: "graphic",
          threshold: 3,
          required: true,
          background: { kind: "solid", color: { kind: "var", name: "--panel" } },
        }
      : {}),
  });
  return {
    ...harness,
    dom,
    target,
    hiddenTarget,
    run: (page = harness.page) =>
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [role],
        policy: M31_POLICY,
      }),
  };
}

const assertD8f2Restored = (sample) => {
  assert.equal(sample.target.style.getPropertyValue("background-color"), "rgb(0, 0, 0)");
  assert.equal(sample.target.style.getPropertyPriority("background-color"), "");
  assert.equal(sample.target.style.getPropertyValue("box-shadow"), "0 0 2px rgb(0, 0, 0)");
  assert.equal(sample.target.style.getPropertyPriority("box-shadow"), "important");
  assert.deepEqual([sample.dom.sandbox.window.scrollX, sample.dom.sandbox.window.scrollY], [11, 13]);
};

test("D8j-adapter：真实适配器接入 measureBrowserRoles，badge 核心采样与 legend surface 均可测", async () => {
  const badgeSample = createD8f2Sample({
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const badgeRole = m32Role("badge.record", { selector: ".badge" });
  const badgeCatalog = adaptRoleCatalogForMeasurement([badgeRole]);
  assert.strictEqual(badgeCatalog[0], badgeRole);
  assert.equal(badgeCatalog[0].foreground, null);
  const badgeResult = await measureBrowserRoles({
    page: badgeSample.page,
    candidate: null,
    mode: "light",
    stateId: "metric-record-visible",
    roleCatalog: badgeCatalog,
    policy: M31_POLICY,
  });
  const badgeRecord = badgeResult.records[0];
  const badgeEvidence = JSON.parse(badgeRecord.evidence);
  const badgeBand = badgeEvidence.nodes[0].bands[0];
  assert.equal(badgeRecord.result, "pass");
  assert.equal(badgeRecord.method, "browser-painted-surface");
  assert.equal(badgeBand.scan.pixelCount, 9);
  assert.deepEqual(badgeSample.screenshots, [{ x: 12.25, y: 22.5, width: 3, height: 3 }]);
  assert.ok(badgeSample.evaluations.includes("occlusion-probe"));
  assert.ok(badgeSample.evaluations.includes("hide"));
  assert.ok(badgeSample.evaluations.includes("restore"));
  assert.ok(badgeSample.evaluations.includes("verify"));
  assertD8f2Restored(badgeSample);

  const legendSample = createD8f2Sample({
    roleId: "chart.legend-swatch",
    stateId: "dense-data",
    pixels: d8f2PixelGrid([255, 255, 255], [255, 255, 255]),
  });
  const legendRole = m32Role("chart.legend-swatch", { selector: ".badge" });
  const legendCatalog = adaptRoleCatalogForMeasurement([legendRole]);
  assert.strictEqual(legendCatalog[0], legendRole);
  assert.equal(legendCatalog[0].foreground, null);
  const legendResult = await measureBrowserRoles({
    page: legendSample.page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: legendCatalog,
    policy: M31_POLICY,
  });
  const legendRecord = legendResult.records[0];
  const legendEvidence = JSON.parse(legendRecord.evidence);
  assert.equal(legendRecord.result, "pass");
  assert.ok(Number.isFinite(legendRecord.ratio));
  assert.equal(legendRecord.method, "browser-painted-surface");
  assert.equal(legendEvidence.nodes[0].bands[0].clip.width, 7);
  assert.equal(legendEvidence.nodes[0].bands[0].clip.height, 7);
  assert.deepEqual(legendSample.screenshots, [{ x: 10.25, y: 20.5, width: 7, height: 7 }]);
  assert.ok(!legendSample.evaluations.includes("occlusion-probe"));
  assert.ok(legendSample.evaluations.includes("hide"));
  assert.ok(legendSample.evaluations.includes("restore"));
  assert.ok(legendSample.evaluations.includes("verify"));
  assertD8f2Restored(legendSample);
});

test("M3.2：节点探测 + 文字隐藏/恢复 round-trip——隐藏只改填充不改 color，恢复后快照一致", () => {
  const dom = createElementStubDom();
  const element = dom.build({
    selector: "input",
    tag: "INPUT",
    id: "pricing-search",
    className: "search-control ".repeat(14),
    type: "search",
    field: true,
    placeholder: "PRIVATE_PLACEHOLDER_TEXT",
    value: "",
    rect: { x: 40, y: 60, width: 200, height: 24 },
    textRects: [{ x: 48, y: 64, width: 120, height: 16 }],
    inline: {
      color: "rgb(35, 49, 60)",
      opacity: "0.83",
      "background-color": "rgb(245, 246, 247)",
      "background-image": "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))",
    },
    pseudo: {
      color: "rgb(120, 120, 120)",
      opacity: "0.76",
      fontSize: "13px",
      content: '"PRIVATE_PLACEHOLDER_TEXT"',
    },
  });
  void element;

  const probe = runInNewContext(
    buildProbeSource("node-probe", "input", "::placeholder", null, true, false, true),
    dom.sandbox,
  );
  assert.equal(probe.nodes.length, 1);
  const node = probe.nodes[0];
  assert.equal(node.hasValue, false);
  assert.equal(node.hasPlaceholder, true);
  assert.equal(node.usesPlaceholder, true, "input 有空 placeholder 且无值时识别为 placeholder 场景");
  assert.deepEqual(hostValue(node.textRects), [{ x: 40, y: 60, width: 200, height: 24 }], "input 文本区取内容框");
  assert.equal(node.pseudo.color, "rgb(120, 120, 120)", "placeholder 颜色从伪元素读取");
  assert.equal(node.pseudo.opacity, "0.76");
  assert.equal(node.computed.color, "rgb(35, 49, 60)", "元素自身 color 保持");
  assert.deepEqual(
    hostValue({
      identityId: node.identityId,
      tag: node.tag,
      id: node.id,
      hostType: node.hostType,
      inputType: node.inputType,
    }),
    { identityId: 1, tag: "input", id: "pricing-search", hostType: "input", inputType: "search" },
  );
  assert.equal(node.className.length, 160, "class 只保留有限长度用于定位");
  assert.equal(node.computed.opacity, "0.83");
  assert.equal(node.computed.backgroundColor, "rgb(245, 246, 247)");
  assert.equal(node.computed.backgroundImage, "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))");
  assert.equal(Object.hasOwn(node.pseudo, "content"), false, "伪元素内容不进入 probe 输出");
  assert.equal(Object.hasOwn(node, "ownOpacityTextProof"), false, "输入控件不采集文字叶证明");
  assert.doesNotMatch(JSON.stringify(node), /PRIVATE_PLACEHOLDER_TEXT/);
  assert.equal(Object.hasOwn(node, "value"), false, "probe 只返回值状态布尔值，不返回输入文本");

  dom.build({
    selector: "#filled-search",
    tag: "INPUT",
    id: "filled-search",
    type: "search",
    field: true,
    placeholder: "PRIVATE_PLACEHOLDER_TEXT",
    value: "PRIVATE_INPUT_VALUE",
    rect: { x: 40, y: 60, width: 200, height: 24 },
  });
  const filled = runInNewContext(
    buildProbeSource("node-probe", "#filled-search", "::placeholder", null, true, false, true),
    dom.sandbox,
  ).nodes[0];
  assert.equal(filled.hasValue, true);
  assert.equal(filled.hasPlaceholder, true);
  assert.equal(filled.usesPlaceholder, false);
  assert.doesNotMatch(JSON.stringify(filled), /PRIVATE_PLACEHOLDER_TEXT|PRIVATE_INPUT_VALUE/);

  const before = {
    color: node.computed.color,
    textFillColor: node.computed.textFillColor,
    textShadow: node.computed.textShadow,
    backgroundColor: node.computed.backgroundColor,
    opacity: node.computed.opacity,
    rect: node.rect,
  };

  const hide = runInNewContext(buildProbeSource("hide", "input", 0, "text"), dom.sandbox);
  assert.equal(hide.ok, true);
  const hidden = runInNewContext("getComputedStyle(document.querySelectorAll('input')[0])", dom.sandbox);
  assert.equal(hidden.webkitTextFillColor, "transparent", "文字填充被隐藏");
  assert.equal(hidden.textShadow, "none", "text-shadow 一并隐藏（泛光不得算作满足对比）");
  assert.equal(hidden.color, "rgb(35, 49, 60)", "color 不得修改（依赖 currentColor 的背景不能被动）");

  const restore = runInNewContext(buildProbeSource("restore", "input", 0, hide.originals), dom.sandbox);
  assert.equal(restore.ok, true);
  const verify = runInNewContext(buildProbeSource("verify", "input", 0), dom.sandbox);
  assert.equal(verify.ok, true);
  const differences = [];
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(verify.after[key])) differences.push(key);
  }
  assert.deepEqual(differences, [], "恢复后原 CSS 声明与几何完全一致");
});

test("B17: M3 节点探针只取 P/LI 自身直接 Text 范围，默认模式仍保留子树文字", () => {
  const dom = createElementStubDom();
  const makeRect = (x, width) => ({ x, y: 10, width, height: 12 });
  const textNode = (textContent, ...rects) => ({ nodeType: 3, textContent, _textRects: rects });
  const linkNode = (textContent, rect) => ({ nodeType: 1, tagName: "A", textContent, _textRects: [rect] });
  const read = (selector, includeOwnTextRanges = false, pseudo = null, includeText = true) =>
    hostValue(
      runInNewContext(
        buildProbeSource("node-probe", selector, pseudo, null, false, includeText, false, includeOwnTextRanges),
        dom.sandbox,
      ).nodes[0],
    );

  const prefixRect = makeRect(0, 20);
  const firstLinkRect = makeRect(20, 30);
  const separatorRect = makeRect(50, 8);
  const secondLinkRect = makeRect(58, 32);
  const suffixRect = makeRect(90, 8);
  const subtreeRects = [prefixRect, firstLinkRect, separatorRect, secondLinkRect, suffixRect];
  dom.build({
    selector: "#cost-copy",
    tag: "P",
    rect: { x: 0, y: 0, width: 120, height: 30 },
    clientLeft: 2,
    clientWidth: 116,
    computed: { overflowX: "hidden" },
    textRects: subtreeRects,
    childNodes: [
      textNode("费用：", prefixRect),
      linkNode("套餐甲", firstLinkRect),
      textNode("、", separatorRect),
      linkNode("套餐乙", secondLinkRect),
      textNode("。", suffixRect),
    ],
  });

  const defaultProbe = read("#cost-copy");
  assert.equal(defaultProbe.text, "费用：套餐甲、套餐乙。");
  assert.deepEqual(defaultProbe.rawTextRects, subtreeRects, "默认 Range 仍探测整棵子树");
  assert.equal(Object.hasOwn(defaultProbe, "ownTextRangeProbe"), false, "默认角色不增加自身文字字段");

  const noTextOutput = dom.build({
    selector: "#text-output-disabled",
    tag: "P",
    rect: { x: 0, y: 0, width: 40, height: 12 },
    textRects: [makeRect(0, 40)],
    text: "must not be read",
  });
  Object.defineProperty(noTextOutput, "textContent", {
    configurable: true,
    get() {
      throw new Error("textContent read while includeText=false");
    },
  });
  const noTextProbe = read("#text-output-disabled", false, null, false);
  assert.equal(Object.hasOwn(noTextProbe, "text"), false, "includeText=false 不读取父节点 textContent");

  const ownTextProbe = read("#cost-copy", true);
  assert.equal(ownTextProbe.text, "费用：、。", "保留前缀与链接间直接分隔符，不拼入链接文字");
  assert.deepEqual(ownTextProbe.ownTextRangeProbe, {
    source: "direct-text-nodes",
    status: "captured",
    reason: null,
    textNodeCount: 3,
  });
  assert.deepEqual(ownTextProbe.rawTextRects, [prefixRect, separatorRect, suffixRect]);
  assert.deepEqual(
    ownTextProbe.textRects,
    [{ x: 2, y: 10, width: 18, height: 12 }, separatorRect, suffixRect],
    "自身 Range 继续经过既有 overflow 裁切路径",
  );
  assert.deepEqual(ownTextProbe.textRectClipping.discardedRawRectIndexes, []);

  dom.build({
    selector: "#plain-li",
    tag: "LI",
    rect: { x: 0, y: 20, width: 100, height: 20 },
    textRects: [makeRect(4, 40)],
    childNodes: [textNode("纯文字项目", makeRect(4, 40))],
  });
  const plainLi = read("#plain-li", true);
  assert.equal(plainLi.ownTextRangeProbe.status, "captured");
  assert.equal(plainLi.text, "纯文字项目");
  assert.equal(plainLi.rawTextRects.length, 1);

  for (const [selector, childNodes] of [
    ["#only-links", [linkNode("链接甲", makeRect(1, 20)), linkNode("链接乙", makeRect(22, 20))]],
    ["#blank-own-text", [textNode(" \n "), linkNode("链接", makeRect(1, 20))]],
  ]) {
    dom.build({
      selector,
      tag: "P",
      rect: { x: 0, y: 40, width: 100, height: 20 },
      textRects: [makeRect(1, 41)],
      childNodes,
    });
    const empty = read(selector, true);
    assert.equal(empty.ownTextRangeProbe.status, "empty", `${selector}: 无直接非空文字明确为空`);
    assert.equal(empty.text, "", `${selector}: 不回退到链接子树文字`);
    assert.deepEqual(empty.rawTextRects, [], `${selector}: 不回退到子树矩形`);
    assert.deepEqual(empty.textRects, []);
  }

  const unsupportedSpecs = [
    { selector: "#not-paragraph", tag: "DIV" },
    {
      selector: "#form-field",
      tag: "INPUT",
      field: true,
      value: "PRIVATE_INPUT_VALUE",
      placeholder: "PRIVATE_PLACEHOLDER_TEXT",
    },
    { selector: "#svg-text", tag: "svg", svg: true, namespaceURI: "http://www.w3.org/2000/svg" },
    { selector: "#editable-paragraph", tag: "P", isContentEditable: true },
  ];
  for (const spec of unsupportedSpecs) {
    dom.build({
      ...spec,
      rect: { x: 0, y: 70, width: 100, height: 20 },
      textRects: [makeRect(1, 41)],
      childNodes: [textNode("不得回退", makeRect(1, 20))],
    });
    const unsupported = read(spec.selector, true);
    assert.equal(unsupported.ownTextRangeProbe.status, "unsupported", spec.selector);
    assert.equal(unsupported.text, "", `${spec.selector}: unsupported 不返回子树文字`);
    assert.deepEqual(unsupported.textRects, [], `${spec.selector}: unsupported 不返回整子树范围`);
    assert.doesNotMatch(JSON.stringify(unsupported), /PRIVATE_INPUT_VALUE|PRIVATE_PLACEHOLDER_TEXT/);
  }
  const pseudoProbe = read("#plain-li", true, "::before");
  assert.equal(pseudoProbe.ownTextRangeProbe.status, "unsupported", "伪元素不是直接 Text Range 目标");
  assert.equal(pseudoProbe.text, "");
});

test("B18: 费用说明只对精确角色/状态/selector走自身文字范围，失效时拒测并保留证据与恢复", async (t) => {
  const selector = "#costEstimateNote > p, #costEstimateNote li";
  const prefixRect = { x: 100, y: 50, width: 34, height: 20 };
  const separatorRect = { x: 136, y: 50, width: 8, height: 20 };
  const linkRect = { x: 146, y: 50, width: 52, height: 20 };
  const directRects = [prefixRect, separatorRect];
  const subtreeRects = [...directRects, linkRect];
  const clipping = {
    source: "Range.getClientRects intersected with axis overflow client rects",
    clips: [],
    discardedRawRectIndexes: [],
    roundedRejectedRawRectIndexes: [],
    unsupportedReason: null,
  };
  const captured = { source: "direct-text-nodes", status: "captured", reason: null, textNodeCount: 2 };
  const makeNode = (tag = "p", marker = captured, { includeMarker = true, subtree = false } = {}) => {
    const node = probeNode(0, {
      tag,
      id: "costEstimateNote",
      rect: { x: 100, y: 50, width: 200, height: 20 },
      textRects: subtree ? subtreeRects : directRects,
      rawTextRects: subtree ? subtreeRects : directRects,
      textRectClipping: clipping,
      ownTextRangeProbe: marker,
    });
    if (!includeMarker) delete node.ownTextRangeProbe;
    return node;
  };
  const makeRole = ({ id = "cost.note-text", stateId = "dashboard-default", rawSelector = selector } = {}) =>
    m32Role("page.body-text", { id, states: [stateId], selector: rawSelector });
  const enabledIn = (source) => /const useOwnTextRanges = true;/.test(source);
  const scripted = (nodeProbe) => {
    const sources = [];
    const page = createScriptedPage(
      defaultHandlers({
        "node-probe": (source) => {
          sources.push(source);
          return nodeProbe(source, sources.length);
        },
        scan: () =>
          scanResult([
            ["text-0-0", [0, 0, 0, 255]],
            ["text-0-1", [0, 0, 0, 255]],
          ]),
      }),
    );
    return { page, sources };
  };
  const run = async (page, role, stateId = "dashboard-default") => {
    try {
      return await measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [role],
        policy: M31_POLICY,
      });
    } catch (error) {
      // This proposed role is intentionally not registered yet; inspect the completed sample before M0 rejects it.
      if (error.measurementEvidence?.phase === "record-validation" && /未知角色/.test(error.message)) {
        return error.measurementEvidence;
      }
      throw error;
    }
  };

  await t.test("P 初探与逐带重探都启用；只采样直接前缀/分隔符，不含链接", async () => {
    const { page, sources } = scripted((source) => ({
      nodes: [makeNode("p", enabledIn(source) ? captured : null, { includeMarker: enabledIn(source) })],
      attemptToken: "attempt-cost-note-p",
    }));
    const result = await run(page, makeRole());
    assert.equal(sources.length, 2, "执行一次初探和一次逐带重探");
    assert.ok(sources.every(enabledIn), "两次实际生成的 node-probe 都显式设置 true");
    const evidence = JSON.parse(result.records[0].evidence);
    assert.equal(result.records[0].result, "pass");
    assert.deepEqual(evidence.nodes[0].ownTextRangeProbe, captured);
    assert.deepEqual(evidence.nodes[0].geometry.rawTextRects, directRects);
    assert.deepEqual(evidence.nodes[0].bands[0].ownTextRangeProbe, captured);
    assert.deepEqual(evidence.nodes[0].bands[0].sampleRects, directRects);
    assert.deepEqual(evidence.nodes[0].bands[0].rawTextRects, directRects);
    assert.deepEqual(page.screenshots.find((screenshot) => screenshot?.clip)?.clip, {
      x: 100,
      y: 50,
      width: 44,
      height: 20,
    });
    assert.ok(!JSON.stringify(evidence).includes(JSON.stringify(linkRect)), "链接矩形不进入该角色证据");
  });

  await t.test("纯 LI 使用同一精确范围", async () => {
    const { sources, page } = scripted((source) => ({
      nodes: [makeNode("li", enabledIn(source) ? captured : null, { includeMarker: enabledIn(source) })],
      attemptToken: "attempt-cost-note-li",
    }));
    await run(page, makeRole());
    assert.equal(sources.length, 2);
    assert.ok(sources.every(enabledIn));
  });

  await t.test("近似角色、状态或 selector 均保留默认 false", async () => {
    const cases = [
      { label: "role", role: makeRole({ id: "cost.note-text-near" }), stateId: "dashboard-default" },
      { label: "state", role: makeRole({ stateId: "quota-toast" }), stateId: "quota-toast" },
      { label: "selector", role: makeRole({ rawSelector: `${selector} ` }), stateId: "dashboard-default" },
    ];
    for (const item of cases) {
      const { sources, page } = scripted(() => ({
        nodes: [makeNode("p", null, { includeMarker: false, subtree: true })],
        attemptToken: `attempt-near-${item.label}`,
      }));
      const result = await run(page, item.role, item.stateId);
      assert.ok(sources.length >= 1);
      assert.ok(
        sources.every((source) => !enabledIn(source)),
        `${item.label} keeps the default probe mode`,
      );
      assert.ok(result.records[0].result === "pass" || result.records[0].result === "unmeasured");
    }
  });

  await t.test("初探缺失/empty/unsupported 不回退到子树范围", async (t2) => {
    const cases = [
      { name: "missing", marker: null, includeMarker: false, reason: /标记缺失/ },
      { name: "empty", marker: { ...captured, status: "empty", textNodeCount: 0 }, reason: /状态为 empty/ },
      {
        name: "unsupported",
        marker: { ...captured, status: "unsupported", reason: "not-p-or-li" },
        reason: /状态为 unsupported/,
      },
    ];
    for (const item of cases) {
      await t2.test(item.name, async () => {
        const { page, sources } = scripted((_source) => ({
          nodes: [makeNode("p", item.marker, { includeMarker: item.includeMarker !== false, subtree: true })],
          attemptToken: `attempt-initial-${item.name}`,
        }));
        const result = await run(page, makeRole());
        const evidence = JSON.parse(result.records[0].evidence);
        assert.equal(result.records[0].result, "unmeasured");
        assert.match(result.records[0].reason, item.reason);
        assert.equal(page.screenshots.filter((screenshot) => screenshot?.clip).length, 0);
        assert.equal(sources.length, 1);
        assert.ok(sources.every(enabledIn));
        assert.ok(
          evidence.nodes[0].geometry.rawTextRects.some((rect) => JSON.stringify(rect) === JSON.stringify(linkRect)),
          "保留收到的子树范围作为拒测诊断",
        );
        assert.deepEqual(evidence.nodes[0].ownTextRangeProbe, item.marker);
      });
    }
  });

  await t.test("逐带重探缺失/empty/unsupported 拒测，保留坏范围证据并沿用恢复与一次重试", async (t2) => {
    const cases = [
      { name: "missing", marker: null, includeMarker: false, reason: /逐带重探时自身文字范围标记缺失/ },
      {
        name: "empty",
        marker: { ...captured, status: "empty", textNodeCount: 0 },
        reason: /逐带重探时自身文字范围状态为 empty/,
      },
      {
        name: "unsupported",
        marker: { ...captured, status: "unsupported", reason: "not-p-or-li" },
        reason: /逐带重探时自身文字范围状态为 unsupported/,
      },
    ];
    for (const item of cases) {
      await t2.test(item.name, async () => {
        const { page, sources } = scripted((_source, call) => {
          const badProbe = call % 2 === 0;
          return {
            nodes: [
              badProbe
                ? makeNode("p", item.marker, { includeMarker: item.includeMarker !== false, subtree: true })
                : makeNode(),
            ],
            attemptToken: `attempt-reprobe-${Math.ceil(call / 2)}`,
          };
        });
        const result = await run(page, makeRole());
        const record = result.records[0];
        const evidence = JSON.parse(record.evidence);
        assert.equal(record.result, "unmeasured");
        assert.match(record.reason, item.reason);
        assert.equal(evidence.attempts, 2, "沿用现有一次完整身份重试");
        assert.equal(sources.length, 4, "两次尝试各初探一次、逐带重探一次");
        assert.ok(sources.every(enabledIn));
        assert.deepEqual(evidence.ownTextRangeProbe, item.marker);
        assert.deepEqual(evidence.rawTextRects, subtreeRects);
        assert.deepEqual(evidence.textRectClipping, clipping);
        assert.equal(page.screenshots.filter((screenshot) => screenshot?.clip).length, 0);
        assert.equal(page.evaluations.filter((tag) => tag === "hide").length, 2);
        assert.equal(page.evaluations.filter((tag) => tag === "restore").length, 2);
        assert.equal(page.evaluations.filter((tag) => tag === "release-attempt").length, 2);
      });
    }
  });
});

test("M5.2.C-D8u28-visible-text-rects：Range 文本矩形按轴向 overflow client 区裁切并保留 raw 证据", async () => {
  const dom = createElementStubDom();
  const read = (selector) =>
    hostValue(runInNewContext(buildProbeSource("node-probe", selector, null, null, true), dom.sandbox).nodes[0]);

  const plain = dom.build({
    selector: "#plain-text",
    rect: { x: 10, y: 10, width: 40, height: 12 },
    textRects: [{ x: 10, y: 10, width: 40, height: 12 }],
    text: "plain",
  });
  const plainProbe = read("#plain-text");
  assert.deepEqual(plainProbe.textRects, plainProbe.rawTextRects, "无 overflow 裁切时保留 Range 几何");
  assert.deepEqual(plainProbe.textRectClipping.clips, []);
  void plain;

  const xParent = dom.build({
    selector: "#x-parent",
    rect: { x: 20, y: 20, width: 40, height: 20 },
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 36,
    clientHeight: 16,
    computed: { overflowX: "clip", overflowY: "visible" },
  });
  dom.build({
    selector: "#x-text",
    parentElement: xParent,
    rect: { x: 16, y: 23, width: 70, height: 8 },
    textRects: [{ x: 16, y: 23, width: 70, height: 8 }],
    text: "x-axis",
  });
  const xProbe = read("#x-text");
  assert.deepEqual(xProbe.textRects, [{ x: 22, y: 23, width: 36, height: 8 }], "只裁 x，y 保持原值");
  assert.equal(xProbe.textRectClipping.clips[0].overflowX, "clip");
  assert.deepEqual(xProbe.textRectClipping.clips[0].clientRect, { left: 22, top: 22, right: 58, bottom: 38 });

  const yParent = dom.build({
    selector: "#y-parent",
    rect: { x: 80, y: 30, width: 80, height: 30 },
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 76,
    clientHeight: 26,
    computed: { overflowX: "visible", overflowY: "clip" },
  });
  dom.build({
    selector: "#y-text",
    parentElement: yParent,
    rect: { x: 85, y: 20, width: 30, height: 40 },
    textRects: [{ x: 85, y: 20, width: 30, height: 40 }],
    text: "y-axis",
  });
  const yProbe = read("#y-text");
  assert.deepEqual(yProbe.textRects, [{ x: 85, y: 32, width: 30, height: 26 }], "只裁 y，x 保持原值");

  const outer = dom.build({
    selector: "#outer",
    rect: { x: 100, y: 40, width: 44, height: 40 },
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 40,
    clientHeight: 40,
    computed: { overflowX: "clip", overflowY: "visible" },
  });
  const inner = dom.build({
    selector: "#inner",
    parentElement: outer,
    rect: { x: 90, y: 48, width: 70, height: 30 },
    clientLeft: 1,
    clientTop: 2,
    clientWidth: 68,
    clientHeight: 26,
    computed: { overflowX: "visible", overflowY: "clip" },
  });
  dom.build({
    selector: "#nested-text",
    parentElement: inner,
    rect: { x: 80, y: 40, width: 100, height: 50 },
    textRects: [{ x: 80, y: 40, width: 100, height: 50 }],
    text: "nested",
  });
  const nestedProbe = read("#nested-text");
  assert.deepEqual(nestedProbe.textRects, [{ x: 100, y: 50, width: 40, height: 26 }]);
  assert.equal(nestedProbe.textRectClipping.clips.length, 2, "两个祖先的裁切来源都留存");

  const borderParent = dom.build({
    selector: "#border-parent",
    rect: { x: 100, y: 100, width: 38, height: 30 },
    clientLeft: 4,
    clientTop: 4,
    clientWidth: 30,
    clientHeight: 22,
    computed: { overflowX: "clip", overflowY: "visible" },
  });
  dom.build({
    selector: "#border-touch",
    parentElement: borderParent,
    rect: { x: 134, y: 110, width: 10, height: 10 },
    textRects: [{ x: 134, y: 110, width: 10, height: 10 }],
    text: "touch",
  });
  dom.build({
    selector: "#border-overlap",
    parentElement: borderParent,
    rect: { x: 133, y: 110, width: 10, height: 10 },
    textRects: [{ x: 133, y: 110, width: 10, height: 10 }],
    text: "one-pixel-overlap",
  });
  const touchingProbe = read("#border-touch");
  const overlapProbe = read("#border-overlap");
  assert.deepEqual(touchingProbe.textRects, [], "边界恰好接触只产生零面积，必须丢弃");
  assert.deepEqual(touchingProbe.textRectClipping.discardedRawRectIndexes, [0]);
  assert.deepEqual(overlapProbe.textRects, [{ x: 133, y: 110, width: 1, height: 10 }], "严格正面积的 1px 交集保留");

  const outsideParent = dom.build({
    selector: "#outside-parent",
    rect: { x: 200, y: 200, width: 30, height: 20 },
    clientWidth: 30,
    clientHeight: 20,
    computed: { overflowX: "clip", overflowY: "visible" },
  });
  dom.build({
    selector: "#outside-text",
    parentElement: outsideParent,
    rect: { x: 240, y: 205, width: 20, height: 10 },
    textRects: [{ x: 240, y: 205, width: 20, height: 10 }],
    text: "outside",
  });
  const outsideProbe = read("#outside-text");
  assert.deepEqual(outsideProbe.textRects, []);
  assert.deepEqual(outsideProbe.rawTextRects, [{ x: 240, y: 205, width: 20, height: 10 }]);
  assert.deepEqual(outsideProbe.textRectClipping.discardedRawRectIndexes, [0]);

  const roundedParent = dom.build({
    selector: "#rounded-parent",
    id: "rounded-parent",
    rect: { x: 300, y: 300, width: 180, height: 120 },
    clientLeft: 4,
    clientTop: 4,
    clientWidth: 172,
    clientHeight: 112,
    computed: {
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "20px",
      borderTopRightRadius: "20px",
      borderBottomRightRadius: "20px",
      borderBottomLeftRadius: "20px",
      borderTopWidth: "4px",
      borderRightWidth: "4px",
      borderBottomWidth: "4px",
      borderLeftWidth: "4px",
    },
  });
  dom.build({
    selector: "#rounded-center",
    id: "rounded-center",
    parentElement: roundedParent,
    rect: { x: 360, y: 340, width: 60, height: 16 },
    textRects: [{ x: 360, y: 340, width: 60, height: 16 }],
    text: "center",
  });
  dom.build({
    selector: "#rounded-straight-edge",
    id: "rounded-straight-edge",
    parentElement: roundedParent,
    rect: { x: 320, y: 305, width: 50, height: 16 },
    textRects: [{ x: 320, y: 305, width: 50, height: 16 }],
    text: "straight edge",
  });
  const roundedCenterProbe = read("#rounded-center");
  const roundedStraightProbe = read("#rounded-straight-edge");
  const roundedEvidence = roundedCenterProbe.textRectClipping.clips.find((item) => item.id === "rounded-parent");
  assert.deepEqual(roundedCenterProbe.textRects, roundedCenterProbe.rawTextRects, "中央矩形完全位于圆角框内时仍可测");
  assert.deepEqual(
    roundedStraightProbe.textRects,
    roundedStraightProbe.rawTextRects,
    "靠近直边且四角安全的矩形不得因简单 radius 内缩而缺测",
  );
  assert.deepEqual(roundedEvidence.roundedClip.borderWidths, { top: 4, right: 4, bottom: 4, left: 4 });
  assert.deepEqual(roundedEvidence.roundedClip.paddingRect, { left: 304, top: 304, right: 476, bottom: 416 });
  assert.deepEqual(
    roundedEvidence.roundedClip.innerRadii.topLeft,
    { x: 16, y: 16 },
    "安全域以 padding/client 边界计算内圆角",
  );

  const r16SquareClip = dom.build({
    selector: "#r16-square-clip",
    id: "r16-square-clip",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    clientWidth: 100,
    clientHeight: 100,
    computed: {
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "16px",
      borderTopRightRadius: "16px",
      borderBottomRightRadius: "16px",
      borderBottomLeftRadius: "16px",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
    },
  });
  dom.build({
    selector: "#r16-arc-safe",
    id: "r16-arc-safe",
    parentElement: r16SquareClip,
    rect: { x: 8, y: 8, width: 1, height: 1 },
    textRects: [{ x: 8, y: 8, width: 1, height: 1 }],
    text: "arc safe",
  });
  dom.build({
    selector: "#r16-boundary-safe",
    id: "r16-boundary-safe",
    parentElement: r16SquareClip,
    rect: { x: 6.4, y: 3.2, width: 1, height: 1 },
    textRects: [{ x: 6.4, y: 3.2, width: 1, height: 1 }],
    text: "ellipse boundary included",
  });
  dom.build({
    selector: "#r16-corner-clipped",
    id: "r16-corner-clipped",
    parentElement: r16SquareClip,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    textRects: [{ x: 0, y: 0, width: 1, height: 1 }],
    text: "outside arc",
  });
  const r16ArcSafeProbe = read("#r16-arc-safe");
  const r16BoundarySafeProbe = read("#r16-boundary-safe");
  const r16CornerClippedProbe = read("#r16-corner-clipped");
  assert.deepEqual(r16ArcSafeProbe.rawTextRects, [{ x: 8, y: 8, width: 1, height: 1 }]);
  assert.deepEqual(r16ArcSafeProbe.textRects, r16ArcSafeProbe.rawTextRects, "(8,8,1,1) 位于16px圆角弧内应可测");
  assert.deepEqual(r16BoundarySafeProbe.rawTextRects, [{ x: 6.4, y: 3.2, width: 1, height: 1 }]);
  assert.deepEqual(r16BoundarySafeProbe.textRects, r16BoundarySafeProbe.rawTextRects, "椭圆边界 s=1 仍属于可见区域");
  assert.deepEqual(r16CornerClippedProbe.rawTextRects, [{ x: 0, y: 0, width: 1, height: 1 }]);
  assert.deepEqual(r16CornerClippedProbe.textRects, [], "(0,0,1,1) 全在被切掉的圆角区域，必须缺测");
  assert.match(r16CornerClippedProbe.textRectClipping.unsupportedReason, /圆角裁切区/);
  assert.deepEqual(r16CornerClippedProbe.textRectClipping.roundedRejectedRawRectIndexes, [0]);

  const outerSafeClip = dom.build({
    selector: "#outer-safe-clip",
    id: "outer-safe-clip",
    rect: { x: 820, y: 300, width: 160, height: 120 },
    clientWidth: 160,
    clientHeight: 120,
    computed: { overflowX: "hidden", overflowY: "hidden" },
  });
  const innerRoundedClip = dom.build({
    selector: "#inner-rounded-clip",
    id: "inner-rounded-clip",
    parentElement: outerSafeClip,
    rect: { x: 800, y: 280, width: 180, height: 120 },
    clientLeft: 4,
    clientTop: 4,
    clientWidth: 172,
    clientHeight: 112,
    computed: {
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "20px",
      borderTopRightRadius: "20px",
      borderBottomRightRadius: "20px",
      borderBottomLeftRadius: "20px",
      borderTopWidth: "4px",
      borderRightWidth: "4px",
      borderBottomWidth: "4px",
      borderLeftWidth: "4px",
    },
  });
  dom.build({
    selector: "#rounded-final-safe",
    id: "rounded-final-safe",
    parentElement: innerRoundedClip,
    rect: { x: 805, y: 285, width: 30, height: 30 },
    textRects: [{ x: 805, y: 285, width: 30, height: 30 }],
    text: "final safe after outer intersection",
  });
  const finalSafeProbe = read("#rounded-final-safe");
  assert.deepEqual(
    finalSafeProbe.textRects,
    [{ x: 820, y: 300, width: 15, height: 15 }],
    "圆角判断必须在所有祖先矩形求交后运行",
  );
  assert.equal(finalSafeProbe.textRectClipping.unsupportedReason, null);

  const unknownRoundedParent = dom.build({
    selector: "#unknown-rounded-parent",
    id: "unknown-rounded-parent",
    rect: { x: 600, y: 300, width: 180, height: 120 },
    clientWidth: 180,
    clientHeight: 120,
    computed: {
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomRightRadius: "50%",
      borderBottomLeftRadius: "50%",
    },
  });
  dom.build({
    selector: "#unknown-rounded-text",
    id: "unknown-rounded-text",
    parentElement: unknownRoundedParent,
    rect: { x: 650, y: 340, width: 60, height: 16 },
    textRects: [{ x: 650, y: 340, width: 60, height: 16 }],
    text: "unknown radius",
  });
  const unknownRoundedProbe = read("#unknown-rounded-text");
  assert.deepEqual(unknownRoundedProbe.textRects, [], "百分比圆角不能被猜成可测");
  assert.match(unknownRoundedProbe.textRectClipping.unsupportedReason, /有限 px 值/);

  const svg = dom.build({
    selector: "#svg-text",
    svg: true,
    parentElement: outsideParent,
    rect: { x: 240, y: 205, width: 20, height: 10 },
    textRects: [{ x: 240, y: 205, width: 20, height: 10 }],
    text: "svg",
  });
  const svgProbe = read("#svg-text");
  assert.equal(svgProbe.isSvg, true);
  assert.deepEqual(svgProbe.textRects, [{ x: 240, y: 205, width: 20, height: 10 }], "SVG 路径保持原始矩形语义");
  assert.equal(Object.hasOwn(svgProbe, "textRectClipping"), false);
  void svg;

  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({
        nodes: [
          probeNode(0, {
            textRects: [],
            rawTextRects: outsideProbe.rawTextRects,
            textRectClipping: outsideProbe.textRectClipping,
          }),
        ],
      }),
    }),
  );
  const measured = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("table.comparison-cell")],
    policy: M31_POLICY,
  });
  const record = measured.records[0];
  const evidence = JSON.parse(record.evidence);
  assert.equal(record.result, "unmeasured", "空交集必须明确记缺测，不能通过或记对比度失败");
  assert.match(record.reason, /没有正面积交集/);
  assert.equal(evidence.unmeasuredNodes[0].geometry.textRects.length, 0);
  assert.equal(evidence.unmeasuredNodes[0].geometry.rawTextRects.length, 1);
  assert.deepEqual(evidence.unmeasuredNodes[0].geometry.textRectClipping.discardedRawRectIndexes, [0]);
  assert.equal(measured.captures.length, 0, "空交集不做该节点的遮挡取点或 PNG 像素扫描");
  assert.equal(page.screenshots.filter((screenshot) => screenshot?.clip).length, 0);
});

test("M5.2.C.t5-D3-effective-rounded-clip：圆角裁切使用 client 与浮点 padding 的正面积交集", async () => {
  const read = (dom, selector) =>
    hostValue(runInNewContext(buildProbeSource("node-probe", selector, null, null, true), dom.sandbox).nodes[0]);
  const roundedStyle = (borderWidths, radius = "21px") => ({
    overflowX: "hidden",
    overflowY: "hidden",
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomRightRadius: radius,
    borderBottomLeftRadius: radius,
    borderTopWidth: `${borderWidths.top}px`,
    borderRightWidth: `${borderWidths.right}px`,
    borderBottomWidth: `${borderWidths.bottom}px`,
    borderLeftWidth: `${borderWidths.left}px`,
  });
  const assertIntersection = (clip, client, padding) => {
    const expected = {
      left: Math.max(client.left, padding.left),
      top: Math.max(client.top, padding.top),
      right: Math.min(client.right, padding.right),
      bottom: Math.min(client.bottom, padding.bottom),
    };
    assert.deepEqual(clip.effectiveClientRect, expected);
    assert.ok(expected.right > expected.left && expected.bottom > expected.top);
  };
  const assertRectClose = (actual, expected, label) => {
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(closeTo(actual[key], expected[key]), `${label}.${key}: ${actual[key]} ≈ ${expected[key]}`);
    }
  };

  const panelDom = createElementStubDom();
  const panel = panelDom.build({
    selector: "#detailPanel",
    id: "detailPanel",
    rect: { x: 1213.328125, y: 603.21875, width: 466.65625, height: 384 },
    clientLeft: 1,
    clientTop: 1,
    clientWidth: 465,
    clientHeight: 382,
    computed: roundedStyle({ top: 1, right: 1, bottom: 1, left: 1 }),
  });
  panelDom.build({
    selector: "#panel-center",
    parentElement: panel,
    rect: { x: 1400, y: 650, width: 40, height: 14 },
    textRects: [{ x: 1400, y: 650, width: 40, height: 14 }],
    text: "panel center",
  });
  panelDom.build({
    selector: "#panel-edge",
    parentElement: panel,
    rect: { x: 1678.7, y: 680, width: 1, height: 10 },
    textRects: [{ x: 1678.7, y: 680, width: 1, height: 10 }],
    text: "panel fractional edge",
  });
  const panelCenter = read(panelDom, "#panel-center");
  const panelEdge = read(panelDom, "#panel-edge");
  const panelClip = panelEdge.textRectClipping.clips.find((clip) => clip.id === "detailPanel");
  assert.deepEqual(panelCenter.textRects, panelCenter.rawTextRects, "D2-R1 detailPanel 中央文字保持可测");
  assert.equal(panelClip.clientRect.right, 1679.328125, "原 integer clientWidth 推导值保留");
  assert.deepEqual(panelClip.roundedClip.paddingRect, {
    left: 1214.328125,
    top: 604.21875,
    right: 1678.984375,
    bottom: 986.21875,
  });
  assertIntersection(panelClip, panelClip.clientRect, panelClip.roundedClip.paddingRect);
  assert.deepEqual(panelEdge.rawTextRects, [{ x: 1678.7, y: 680, width: 1, height: 10 }]);
  assertRectClose(panelEdge.textRects[0], { x: 1678.7, y: 680, width: 0.284375, height: 10 }, "detailPanel edge");
  assert.equal(panelEdge.textRectClipping.unsupportedReason, null);

  const dialogDom = createElementStubDom();
  const dialog = dialogDom.build({
    selector: "#importDialog",
    id: "importDialog",
    rect: { x: 700, y: 353.53125, width: 520, height: 372.9375 },
    clientLeft: 1,
    clientTop: 1,
    clientWidth: 518,
    clientHeight: 371,
    computed: {
      ...roundedStyle({ top: 1, right: 1, bottom: 1, left: 1 }),
      overflowX: "auto",
      overflowY: "auto",
    },
  });
  dialogDom.build({
    selector: "#dialog-bottom-edge",
    parentElement: dialog,
    rect: { x: 900, y: 725.4, width: 30, height: 0.2 },
    textRects: [{ x: 900, y: 725.4, width: 30, height: 0.2 }],
    text: "dialog fractional bottom edge",
  });
  const dialogEdge = read(dialogDom, "#dialog-bottom-edge");
  const dialogClip = dialogEdge.textRectClipping.clips.find((clip) => clip.id === "importDialog");
  assert.equal(dialogClip.clientRect.bottom, 725.53125, "原 integer clientHeight 推导值保留");
  assert.equal(dialogClip.roundedClip.paddingRect.bottom, 725.46875);
  assertIntersection(dialogClip, dialogClip.clientRect, dialogClip.roundedClip.paddingRect);
  assert.deepEqual(dialogEdge.rawTextRects, [{ x: 900, y: 725.4, width: 30, height: 0.2 }]);
  assertRectClose(dialogEdge.textRects[0], { x: 900, y: 725.4, width: 30, height: 0.06875 }, "dialog bottom edge");
  assert.equal(dialogEdge.textRectClipping.unsupportedReason, null);

  const scrollDom = createElementStubDom();
  const scrollClip = scrollDom.build({
    selector: "#fractional-scroll-clip",
    id: "fractional-scroll-clip",
    rect: { x: 40, y: 50, width: 100, height: 80 },
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 95,
    clientHeight: 65,
    computed: roundedStyle({ top: 0.75, right: 1.5, bottom: 1.125, left: 0.5 }, "8px"),
  });
  scrollDom.build({
    selector: "#scroll-edge-text",
    parentElement: scrollClip,
    rect: { x: 39, y: 49, width: 100, height: 80 },
    textRects: [
      { x: 40.2, y: 80, width: 10, height: 8 },
      { x: 130, y: 80, width: 10, height: 8 },
      { x: 80, y: 50.2, width: 8, height: 10 },
      { x: 80, y: 110, width: 8, height: 10 },
    ],
    text: "four straight-edge fragments",
  });
  const scrollProbe = read(scrollDom, "#scroll-edge-text");
  const scrollEvidence = scrollProbe.textRectClipping.clips[0];
  assert.deepEqual(scrollEvidence.roundedClip.paddingRect, {
    left: 40.5,
    top: 50.75,
    right: 138.5,
    bottom: 128.875,
  });
  assert.deepEqual(scrollEvidence.clientRect, { left: 40, top: 50, right: 135, bottom: 115 });
  assertIntersection(scrollEvidence, scrollEvidence.clientRect, scrollEvidence.roundedClip.paddingRect);
  assert.deepEqual(scrollEvidence.effectiveClientRect, { left: 40.5, top: 50.75, right: 135, bottom: 115 });
  assert.ok(
    scrollEvidence.effectiveClientRect.right < scrollEvidence.roundedClip.paddingRect.right,
    "不把右侧滚动条保留区放回可见范围",
  );
  assert.ok(
    scrollEvidence.effectiveClientRect.bottom < scrollEvidence.roundedClip.paddingRect.bottom,
    "不把底部滚动条保留区放回可见范围",
  );
  assert.equal(scrollProbe.textRectClipping.unsupportedReason, null);
  assert.equal(scrollProbe.rawTextRects.length, 4);
  assertRectClose(scrollProbe.textRects[0], { x: 40.5, y: 80, width: 9.7, height: 8 }, "left padding edge");
  assertRectClose(scrollProbe.textRects[1], { x: 130, y: 80, width: 5, height: 8 }, "right client edge");
  assertRectClose(scrollProbe.textRects[2], { x: 80, y: 50.75, width: 8, height: 9.45 }, "top padding edge");
  assertRectClose(scrollProbe.textRects[3], { x: 80, y: 110, width: 8, height: 5 }, "bottom client edge");

  const invalidRoundedProbe = (selector, client) => {
    const dom = createElementStubDom();
    const parent = dom.build({
      selector: `${selector}-clip`,
      rect: { x: 0, y: 0, width: 100, height: 80 },
      clientLeft: client.left ?? 1,
      clientTop: client.top ?? 1,
      clientWidth: client.width ?? 96,
      clientHeight: client.height ?? 76,
      computed: roundedStyle({ top: 2, right: 2, bottom: 2, left: 2 }, "16px"),
    });
    dom.build({
      selector,
      parentElement: parent,
      rect: { x: 30, y: 30, width: 20, height: 10 },
      textRects: [{ x: 30, y: 30, width: 20, height: 10 }],
      text: "invalid rounded clip",
    });
    const probe = read(dom, selector);
    assert.deepEqual(probe.textRects, [], `${selector}: unsupported geometry exposes no text rectangles`);
    assert.equal(probe.rawTextRects.length, 1, `${selector}: retain the original Range evidence`);
    assert.ok(probe.textRectClipping.unsupportedReason, `${selector}: retain an explicit unsupported reason`);
    return { dom, probe };
  };
  const disjoint = invalidRoundedProbe("#disjoint-rounded", { left: 99, width: 1 });
  assert.match(disjoint.probe.textRectClipping.unsupportedReason, /正面积交集/);
  const nonfinite = invalidRoundedProbe("#nonfinite-rounded", { left: Number.NaN });
  assert.match(nonfinite.probe.textRectClipping.unsupportedReason, /有限数值/);
  const zeroArea = invalidRoundedProbe("#zero-area-rounded", { left: 1, width: 0 });
  assert.match(zeroArea.probe.textRectClipping.unsupportedReason, /正面积交集/);

  const curveDom = createElementStubDom();
  const curveClip = curveDom.build({
    selector: "#curve-clip",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    clientWidth: 100,
    clientHeight: 100,
    computed: roundedStyle({ top: 0, right: 0, bottom: 0, left: 0 }, "16px"),
  });
  curveDom.build({
    selector: "#curve-edge-text",
    parentElement: curveClip,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    textRects: [{ x: 0, y: 0, width: 1, height: 1 }],
    text: "inside clipped curve",
  });
  const curveProbe = read(curveDom, "#curve-edge-text");
  assert.deepEqual(curveProbe.textRects, [], "真实圆角曲线越界继续拒测");
  assert.match(curveProbe.textRectClipping.unsupportedReason, /圆角裁切区/);
  assert.deepEqual(curveProbe.textRectClipping.roundedRejectedRawRectIndexes, [0]);

  const invalidHarness = createActualSurfacePage(zeroArea.dom, { pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]) });
  const unmeasured = await measureBrowserRoles({
    page: invalidHarness.page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("table.comparison-cell", { selector: "#zero-area-rounded", states: ["dense-data"] })],
    policy: M31_POLICY,
  });
  assert.equal(unmeasured.records[0].result, "unmeasured", "无正面积交集不能被记录成 PASS");
  assert.equal(unmeasured.records[0].ratio, null);
  assert.match(unmeasured.records[0].reason, /不受支持/);
  assert.equal(JSON.parse(unmeasured.records[0].evidence).unmeasuredNodes[0].geometry.textRects.length, 0);
  assert.equal(unmeasured.captures.length, 0, "不为不受支持的几何生成测量截图");
  assert.equal(invalidHarness.screenshots.length, 0);
});

test("D8f1-shadow：legacy 和 identity surface 隔离都清除 CSS 阴影并移除原空声明", () => {
  for (const useAttemptToken of [false, true]) {
    const dom = createElementStubDom();
    const target = dom.build({
      selector: ".surface",
      rect: { x: 0, y: 0, width: 8, height: 8 },
      computed: { boxShadow: "0 0 8px rgb(69, 86, 102)" },
    });
    const probe = useAttemptToken
      ? runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), dom.sandbox)
      : null;
    const hide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface", probe?.attemptToken), dom.sandbox);
    assert.equal(hide.ok, true);
    assert.equal(hostValue(hide.originals)["box-shadow"], "", "CSS 阴影原本没有 inline 声明");
    assert.equal(target.style.getPropertyValue("box-shadow"), "none");
    assert.equal(dom.sandbox.getComputedStyle(target).boxShadow, "none");
    assert.equal(hide.isolation?.isolated ?? true, true);

    const restored = useAttemptToken
      ? runInNewContext(buildProbeSource("restore", hide.token), dom.sandbox)
      : runInNewContext(buildProbeSource("restore", ".surface", 0, hide.originals), dom.sandbox);
    assert.equal(restored.ok, true);
    if (useAttemptToken) {
      assert.equal(restored.inlineRestored, true);
      assert.equal(runInNewContext(buildProbeSource("verify", hide.token), dom.sandbox).inlineRestored, true);
    }
    assert.equal(target.style.getPropertyValue("background-color"), "", "原空背景声明必须删除");
    assert.equal(target.style.getPropertyValue("box-shadow"), "", "原空阴影声明必须删除");
  }

  const legacyDom = createElementStubDom();
  const legacyTarget = legacyDom.build({
    selector: ".surface",
    rect: { x: 0, y: 0, width: 8, height: 8 },
    inline: {
      "background-color": "rgb(69, 86, 102)",
      "background-color!priority": "important",
      "box-shadow": "0 0 8px rgb(69, 86, 102)",
      "box-shadow!priority": "important",
    },
  });
  const legacyHide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface"), legacyDom.sandbox);
  assert.equal(legacyHide.originals["box-shadowPriority"], "important");
  assert.equal(
    runInNewContext(buildProbeSource("restore", ".surface", 0, legacyHide.originals), legacyDom.sandbox).ok,
    true,
  );
  assert.equal(legacyTarget.style.getPropertyValue("box-shadow"), "0 0 8px rgb(69, 86, 102)");
  assert.equal(legacyTarget.style.getPropertyPriority("box-shadow"), "important");
  assert.equal(legacyTarget.style.getPropertyValue("background-color"), "rgb(69, 86, 102)");
  assert.equal(legacyTarget.style.getPropertyPriority("background-color"), "important");
});

test("D8f1-shadow：important inline 阴影精确恢复，CSS important 残留则拒绝隔离", () => {
  const inlineDom = createElementStubDom();
  const inlineTarget = inlineDom.build({
    selector: ".surface",
    rect: { x: 0, y: 0, width: 8, height: 8 },
    inline: {
      "background-color": "rgb(69, 86, 102)",
      "background-color!priority": "important",
      "box-shadow": "0 0 8px rgb(69, 86, 102)",
      "box-shadow!priority": "important",
    },
  });
  const inlineProbe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), inlineDom.sandbox);
  const inlineHide = runInNewContext(
    buildProbeSource("hide", ".surface", 0, "surface", inlineProbe.attemptToken),
    inlineDom.sandbox,
  );
  assert.equal(inlineHide.isolation.isolated, true);
  assert.equal(inlineHide.originals["box-shadow"], "0 0 8px rgb(69, 86, 102)");
  assert.equal(inlineHide.originals["box-shadowPriority"], "important");
  assert.equal(inlineHide.originals["background-colorPriority"], "important");
  const inlineRestore = runInNewContext(buildProbeSource("restore", inlineHide.token), inlineDom.sandbox);
  const inlineVerify = runInNewContext(buildProbeSource("verify", inlineHide.token), inlineDom.sandbox);
  assert.equal(inlineRestore.inlineRestored, true);
  assert.equal(inlineVerify.inlineRestored, true);
  assert.equal(inlineTarget.style.getPropertyValue("box-shadow"), "0 0 8px rgb(69, 86, 102)");
  assert.equal(inlineTarget.style.getPropertyPriority("box-shadow"), "important");
  assert.equal(inlineTarget.style.getPropertyValue("background-color"), "rgb(69, 86, 102)");
  assert.equal(inlineTarget.style.getPropertyPriority("background-color"), "important");

  // This is the old false-positive: transparent background alone said isolated while a CSS !important glow remained.
  const cssDom = createElementStubDom();
  const cssTarget = cssDom.build({
    selector: ".surface",
    rect: { x: 0, y: 0, width: 8, height: 8 },
    computed: { boxShadow: "0 0 8px rgb(69, 86, 102)" },
    computedPriorities: { boxShadow: "important" },
  });
  const cssProbe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), cssDom.sandbox);
  const cssHide = runInNewContext(
    buildProbeSource("hide", ".surface", 0, "surface", cssProbe.attemptToken),
    cssDom.sandbox,
  );
  assert.equal(cssDom.sandbox.getComputedStyle(cssTarget).backgroundColor, "transparent");
  assert.equal(cssDom.sandbox.getComputedStyle(cssTarget).boxShadow, "0 0 8px rgb(69, 86, 102)");
  assert.equal(cssHide.isolation.isolated, false);
  assert.deepEqual(hostValue(cssHide.isolation.remaining), ["box-shadow"]);
  const cssRestore = runInNewContext(buildProbeSource("restore", cssHide.token), cssDom.sandbox);
  assert.equal(cssRestore.inlineRestored, true);
});

test("D8m-style-restore：token恢复属性存在性，且不覆盖隔离期间新增声明", () => {
  const scenarios = [
    { name: "missing", attributes: {}, present: false },
    { name: "explicit-empty", attributes: { style: "" }, present: true },
    {
      name: "important",
      attributes: {},
      present: true,
      inline: {
        "background-color": "rgb(69, 86, 102)",
        "background-color!priority": "important",
        "box-shadow": "0 0 8px rgb(69, 86, 102)",
        "box-shadow!priority": "important",
      },
    },
    { name: "unrelated", attributes: {}, present: false, addUnrelated: true },
  ];
  for (const scenario of scenarios) {
    for (const path of ["normal", "release"]) {
      const dom = createElementStubDom();
      const target = dom.build({
        selector: ".surface",
        rect: { x: 0, y: 0, width: 8, height: 8 },
        attributes: scenario.attributes,
        inline: scenario.inline,
      });
      assert.equal(target.hasAttribute("style"), scenario.present, `${scenario.name}/${path}: before`);
      const probe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), dom.sandbox);
      const hide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface", probe.attemptToken), dom.sandbox);
      const session = dom.sandbox.window.__skinPaletteMeasurementStash.sessions.get(hide.token);
      assert.equal(session.originalStyleAttributePresent, scenario.present, `${scenario.name}: session metadata`);
      assert.equal(
        Object.hasOwn(session.originals, "originalStyleAttributePresent"),
        false,
        "metadata stays outside declarations",
      );
      if (scenario.addUnrelated) target.style.setProperty("color", "rgb(1, 2, 3)", "important");

      if (path === "normal") {
        const restore = runInNewContext(buildProbeSource("restore", hide.token), dom.sandbox);
        assert.equal(restore.inlineRestored, true, `${scenario.name}: normal restore`);
        const verify = runInNewContext(buildProbeSource("verify", hide.token), dom.sandbox);
        assert.equal(verify.inlineRestored, true, `${scenario.name}: verify`);
      } else {
        const release = runInNewContext(buildProbeSource("release-attempt", probe.attemptToken), dom.sandbox);
        assert.equal(release.ok, true, `${scenario.name}: release-attempt`);
      }

      if (scenario.name === "missing") {
        assert.equal(target.hasAttribute("style"), false, `${path}: originally absent style stays absent`);
        assert.equal(target.style.cssText, "");
      } else if (scenario.name === "explicit-empty") {
        assert.equal(target.hasAttribute("style"), true, `${path}: explicit empty style stays present`);
        assert.equal(target.getAttribute("style"), "");
      } else if (scenario.name === "important") {
        for (const property of ["background-color", "box-shadow"]) {
          assert.equal(target.style.getPropertyPriority(property), "important", `${path}: ${property} priority`);
        }
      } else {
        assert.equal(target.hasAttribute("style"), true, `${path}: added declaration keeps style attribute`);
        assert.equal(target.style.getPropertyValue("color"), "rgb(1, 2, 3)");
        assert.equal(target.style.getPropertyPriority("color"), "important");
      }
    }
  }

  const legacyDom = createElementStubDom();
  const legacyTarget = legacyDom.build({ selector: ".surface", rect: { x: 0, y: 0, width: 8, height: 8 } });
  const legacyHide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface"), legacyDom.sandbox);
  runInNewContext(buildProbeSource("restore", ".surface", 0, legacyHide.originals), legacyDom.sandbox);
  assert.equal(legacyTarget.hasAttribute("style"), true, "旧 selector/index 接口保留原行为");
});

test("D8m-style-restore：verify 发现本应缺失但仍为空的 style 属性", () => {
  const dom = createElementStubDom();
  const target = dom.build({ selector: ".surface", rect: { x: 0, y: 0, width: 8, height: 8 } });
  const probe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface", probe.attemptToken), dom.sandbox);
  const restore = runInNewContext(buildProbeSource("restore", hide.token), dom.sandbox);
  assert.equal(restore.inlineRestored, true);
  target.setAttribute("style", "");
  const verify = runInNewContext(buildProbeSource("verify", hide.token), dom.sandbox);
  assert.equal(verify.inlineRestored, false);
  const release = runInNewContext(buildProbeSource("release-attempt", probe.attemptToken), dom.sandbox);
  assert.equal(release.ok, true);
  assert.equal(target.hasAttribute("style"), false, "finally cleanup retries the missing-attribute restoration");
});

test("M5.2.C-D8u14：删除 CSSOM 空属性前同步读取 raw style", () => {
  const dom = createElementStubDom();
  const target = dom.build({ selector: ".surface", rect: { x: 0, y: 0, width: 8, height: 8 } });
  const events = [];
  let pendingRawStyleSync = false;
  let rawStyleSynced = false;
  const removeProperty = target.style.removeProperty.bind(target.style);
  const getAttribute = target.getAttribute.bind(target);
  const removeAttribute = target.removeAttribute.bind(target);

  target.style.removeProperty = (property) => {
    const previous = removeProperty(property);
    if (target.style.cssText === "" && target.hasAttribute("style")) {
      pendingRawStyleSync = true;
      rawStyleSynced = false;
    }
    return previous;
  };
  target.getAttribute = (name) => {
    if (name === "style" && pendingRawStyleSync) {
      events.push("raw-get");
      rawStyleSynced = true;
    }
    return getAttribute(name);
  };
  target.removeAttribute = (name) => {
    if (name === "style" && pendingRawStyleSync) {
      events.push(rawStyleSynced ? "remove-after-raw-get" : "remove-before-raw-get");
      if (!rawStyleSynced) return;
      pendingRawStyleSync = false;
    }
    return removeAttribute(name);
  };

  const probe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface", probe.attemptToken), dom.sandbox);
  assert.equal(target.hasAttribute("style"), true, "隔离会临时创建 style 属性");
  assert.notEqual(target.style.cssText, "", "隔离先写入声明再供恢复删除");

  const restore = runInNewContext(buildProbeSource("restore", hide.token), dom.sandbox);
  assert.equal(restore.inlineRestored, true, "raw style 同步后可以删除 CSSOM 遗留空属性");
  assert.deepEqual(events, ["raw-get", "remove-after-raw-get"], "必须先读 raw 属性再删除");
  assert.equal(target.hasAttribute("style"), false, "原本缺失的 style 属性恢复为缺失");
});

test("D8f1-shadow：解码后同一元素重新获得光晕会拒绝像素", async () => {
  const dom = createElementStubDom();
  const target = dom.build({
    selector: ".surface",
    rect: { x: 0, y: 0, width: 4, height: 4 },
    computed: { boxShadow: "0 0 8px rgb(69, 86, 102)" },
  });
  const probe = runInNewContext(buildProbeSource("node-probe", ".surface", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".surface", 0, "surface", probe.attemptToken), dom.sandbox);
  assert.equal(hide.isolation.isolated, true);
  target._computedPriorities.boxShadow = "important";

  const png = createPngStubDom({ width: 4, height: 4, fill: () => [255, 255, 255, 255] });
  const scanSandbox = {
    window: dom.sandbox.window,
    document: { ...dom.sandbox.document, createElement: png.sandbox.document.createElement },
    getComputedStyle: dom.sandbox.getComputedStyle,
    HTMLInputElement: dom.sandbox.HTMLInputElement,
    HTMLTextAreaElement: dom.sandbox.HTMLTextAreaElement,
    SVGElement: dom.sandbox.SVGElement,
    Image: png.sandbox.Image,
  };
  const scan = await runInNewContext(
    buildProbeSource(
      "scan",
      "png-base64",
      [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }],
      { x: 0, y: 0, width: 4, height: 4 },
      hide.token,
    ),
    scanSandbox,
  );
  assert.equal(scan.identityValid, true);
  assert.equal(scan.isolationValid, false);
  assert.match(scan.isolationReason, /自身填充仍未清空/);
  assert.match(scan.isolationReason, /box-shadow/);
  assert.deepEqual(hostValue(scan.regions), []);
});

test("D8f1-shadow：截图异常经过生产 finally 后恢复 surface 值与 important 优先级", async () => {
  const dom = createElementStubDom();
  const target = dom.build({
    selector: ".surface",
    rect: { x: 20, y: 20, width: 8, height: 8 },
    inline: {
      "background-color": "rgb(69, 86, 102)",
      "background-color!priority": "important",
      "box-shadow": "0 0 8px rgb(69, 86, 102)",
      "box-shadow!priority": "important",
    },
  });
  const evaluations = [];
  const fullPageFixture = createStableFullPageNodePage();
  const page = {
    async evaluate(source, argument) {
      if (typeof source === "function") return fullPageFixture.page.evaluate(source, argument);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      evaluations.push(tag);
      if (tag === "spotlight-stability") {
        return { stable: true, reason: null, budgetMs: 500, waitedMs: 0, frameCount: 1, transitionsWaited: 0 };
      }
      if (tag === "color-parse")
        return { ok: true, rgb: [69 / 255, 86 / 255, 102 / 255], alpha: 1, readBack: "rgb(69, 86, 102)" };
      if (tag === "scroll-begin") return { ok: true, alreadyActive: false, movedContainers: 0 };
      if (tag === "scroll-restore") return { ok: true, restored: true };
      return runInNewContext(String(source), dom.sandbox);
    },
    async screenshot(options) {
      if (options.fullPage) return fullPageFixture.page.screenshot(options);
      if (options.clip) {
        assert.equal(target.style.getPropertyValue("background-color"), "transparent");
        assert.equal(target.style.getPropertyValue("box-shadow"), "none");
        throw new Error("simulated screenshot cancellation");
      }
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
  };
  const measure = () =>
    measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId: "spotlight-on",
      roleCatalog: [
        m32Role("spotlight.tinted-surface", {
          kind: "graphic",
          selector: ".surface",
          threshold: 3,
          required: true,
          background: { kind: "solid", color: { kind: "var", name: "--panel" } },
        }),
      ],
      policy: M31_POLICY,
    });
  await assert.rejects(measure(), /simulated screenshot cancellation/);
  assert.ok(evaluations.includes("hide"));
  assert.ok(evaluations.includes("restore"));
  assert.ok(evaluations.includes("release-attempt"));
  assert.equal(target.style.getPropertyValue("background-color"), "rgb(69, 86, 102)");
  assert.equal(target.style.getPropertyPriority("background-color"), "important");
  assert.equal(target.style.getPropertyValue("box-shadow"), "0 0 8px rgb(69, 86, 102)");
  assert.equal(target.style.getPropertyPriority("box-shadow"), "important");

  target.style.removeProperty("background-color");
  target.style.removeProperty("box-shadow");
  target.removeAttribute("style");
  evaluations.length = 0;
  assert.equal(target.hasAttribute("style"), false);
  await assert.rejects(measure(), /simulated screenshot cancellation/);
  assert.ok(evaluations.includes("restore"));
  assert.ok(evaluations.includes("release-attempt"));
  assert.equal(target.hasAttribute("style"), false, "measureBrowserRoles 异常 finally 恢复原本缺失的属性");
  assert.equal(target.style.cssText, "");
});

test("D8f1-shadow：SVG opacity 隔离仍按原 priority 恢复", () => {
  const dom = createElementStubDom();
  const target = dom.build({
    selector: ".icon",
    tag: "SVG",
    svg: true,
    rect: { x: 0, y: 0, width: 8, height: 8 },
    inline: { opacity: "0.7", "opacity!priority": "important" },
  });
  const probe = runInNewContext(buildProbeSource("node-probe", ".icon", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".icon", 0, "svg", probe.attemptToken), dom.sandbox);
  assert.equal(target.style.getPropertyValue("opacity"), "0");
  const restore = runInNewContext(buildProbeSource("restore", hide.token), dom.sandbox);
  const verify = runInNewContext(buildProbeSource("verify", hide.token), dom.sandbox);
  assert.equal(restore.inlineRestored, true);
  assert.equal(verify.inlineRestored, true);
  assert.equal(target.style.getPropertyValue("opacity"), "0.7");
  assert.equal(target.style.getPropertyPriority("opacity"), "important");
});

test("D8f2-core：badge.record 截图和扫描只覆盖中央 3×3，外圈极端颜色不参与 worst", async () => {
  const sample = createD8f2Sample({
    rect: { x: 10.25, y: 20.5, width: 7.0000005, height: 6.9999995 },
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);
  const band = evidence.nodes[0].bands[0];

  assert.equal(record.result, "pass");
  assert.equal(record.ratio, 21);
  assert.deepEqual(sample.screenshots, [{ x: 12.25000025, y: 22.49999975, width: 3, height: 3 }]);
  assert.equal(band.scan.columns, 3);
  assert.equal(band.scan.rows, 3);
  assert.equal(band.scan.pixelCount, 9);
  assert.equal(band.scan.channelCount, 36);
  assert.deepEqual(band.worst.background, [255, 255, 255, 255]);
  assert.deepEqual([band.worst.x, band.worst.y], [12.25000025, 22.49999975]);
  assert.ok(sample.evaluations.includes("occlusion-probe"));
  assert.equal(result.diagnostics.restoration.scrollDifferences.length, 0);
  assertD8f2Restored(sample);
});

test("D8f2-core：圆点中央低对比即使外圈高对比仍判 fail", async () => {
  const sample = createD8f2Sample({
    pixels: d8f2PixelGrid([30, 30, 30], [255, 255, 255]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const band = JSON.parse(record.evidence).nodes[0].bands[0];

  assert.equal(record.result, "fail");
  assert.ok(record.ratio < record.threshold);
  assert.equal(band.scan.columns, 3);
  assert.equal(band.scan.rows, 3);
  assert.deepEqual(band.worst.background, [30, 30, 30, 255]);
  assert.deepEqual([band.worst.x, band.worst.y], [12.25, 22.5]);
  assertD8f2Restored(sample);
});

test("D8f2-core：双倍截图 scale 保留 CSS 像素间距与最差样本位置", async () => {
  const pixels = d8f2PixelGrid([255, 255, 255], [0, 0, 0]);
  pixels[3][3] = [30, 30, 30, 255];
  const sample = createD8f2Sample({ pixels, scanWidth: 6, scanHeight: 6 });
  const result = await sample.run();
  const record = result.records[0];
  const band = JSON.parse(record.evidence).nodes[0].bands[0];

  assert.equal(record.result, "fail");
  assert.deepEqual(band.scan, {
    columns: 6,
    rows: 6,
    pixelCount: 36,
    channelCount: 144,
    origin: { x: 0, y: 0 },
  });
  assert.equal(band.scanScale.x, 2);
  assert.equal(band.scanScale.y, 2);
  assert.deepEqual(band.worst.background, [30, 30, 30, 255]);
  assert.deepEqual([band.worst.x, band.worst.y], [13.25, 23.5]);
  assertD8f2Restored(sample);
});

test("D8f2-core：不支持的 7×7 几何明确 unmeasured，不回退整盒", async () => {
  const sample = createD8f2Sample({
    rect: { x: 10.25, y: 20.5, width: 8, height: 8 },
    clientWidth: 8,
    clientHeight: 8,
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "unmeasured");
  assert.match(record.reason, /7×7/);
  assert.equal(sample.screenshots.length, 0);
  assert.match(evidence.nodes[0].rejectedReason, /7×7/);
  assertD8f2Restored(sample);
});

test("D8f2-core：隐藏零尺寸徽标记 notRendered，可见 7×7 徽标仍正常测量", async () => {
  const sample = createD8f2Sample({
    includeHiddenMatch: true,
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "pass");
  assert.equal(record.ratio, 21);
  assert.equal(evidence.measuredCount, 1);
  assert.equal(evidence.notRenderedCount, 1);
  assert.match(evidence.notRenderedReasons[0], /display:none/);
  assert.equal(evidence.unmeasuredCount, 0);
  assert.equal(sample.screenshots.length, 1, "只截取可见徽标的中央核心");
  assert.equal(sample.hiddenTarget.style.getPropertyValue("background-color"), "");
  assert.equal(sample.hiddenTarget.style.getPropertyValue("box-shadow"), "");
  assertD8f2Restored(sample);
});

test("D8f2-core：中央五点命中圆点外部时拒绝取样并保留遮挡证据", async () => {
  const sample = createD8f2Sample({
    occluded: true,
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);
  const node = evidence.nodes[0];
  const points = node.bands[0].occlusion.rects[0].points;

  assert.equal(record.result, "unmeasured");
  assert.match(record.reason, /宿主及其后代之外的命中/);
  assert.equal(sample.screenshots.length, 0);
  assert.equal(points.length, 5);
  assert.ok(points.every((point) => point.withinHost === false && point.top?.id === "overlay"));
  assert.match(node.rejectedReason, /宿主及其后代之外的命中/);
  assertD8f2Restored(sample);
});

test("D8f2-core：不足、空或非法像素网格均 unmeasured", async (t) => {
  const cases = [
    {
      name: "1×1 网格",
      options: { scanWidth: 1, scanHeight: 1 },
    },
    {
      name: "空像素数组",
      options: {
        mutateScan: (scan) => {
          const region = scan.regions?.[0];
          assert.ok(region, `actual scan region missing: ${JSON.stringify(scan)}`);
          region.pixels = [];
          return scan;
        },
      },
    },
    {
      name: "扫描区域缺失",
      options: {
        mutateScan: (scan) => {
          scan.regions = [];
          return scan;
        },
      },
    },
    {
      name: "超出 RGBA 范围的通道值",
      options: {
        mutateScan: (scan) => {
          const region = scan.regions?.[0];
          assert.ok(region, `actual scan region missing: ${JSON.stringify(scan)}`);
          region.pixels[0] = 256;
          return scan;
        },
      },
    },
  ];
  for (const { name, options } of cases) {
    await t.test(name, async () => {
      const sample = createD8f2Sample({
        pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
        ...options,
      });
      const result = await sample.run();
      const record = result.records[0];
      const evidence = JSON.parse(record.evidence);

      assert.equal(record.result, "unmeasured");
      assert.match(record.reason, /核心像素不足或扫描数据无效/);
      assert.match(evidence.nodes[0].rejectedReason, /核心像素不足或扫描数据无效/);
      assertD8f2Restored(sample);
    });
  }
});

test("D8f2-core：普通 surface 仍截图完整内容框，不启用 badge 遮挡探针", async () => {
  const sample = createD8f2Sample({
    roleId: "spotlight.tinted-surface",
    stateId: "spotlight-on",
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const result = await sample.run();
  const record = result.records[0];
  const band = JSON.parse(record.evidence).nodes[0].bands[0];

  assert.equal(record.result, "fail");
  assert.deepEqual(sample.screenshots, [{ x: 10.25, y: 20.5, width: 7, height: 7 }]);
  assert.deepEqual(band.worst.background, [0, 0, 0, 255]);
  assert.ok(!sample.evaluations.includes("occlusion-probe"));
  assertD8f2Restored(sample);
});

test("D8f2-core：截图异常也经 finally 恢复圆点背景、光晕和滚动", async () => {
  const sample = createD8f2Sample({
    pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
  });
  const screenshot = sample.page.screenshot.bind(sample.page);
  sample.page.screenshot = async (options) => {
    if (options.clip) throw new Error("simulated badge screenshot cancellation");
    return screenshot(options);
  };

  await assert.rejects(sample.run(), /simulated badge screenshot cancellation/);
  assert.ok(sample.evaluations.includes("restore"));
  assert.ok(sample.evaluations.includes("release-attempt"));
  assertD8f2Restored(sample);
});

test("M5.2.C-D2b3：只隔离指定箭头和 search 清除叉，并逐项恢复 priority、marker、值与焦点", () => {
  const dom = createElementStubDom();
  const zone = dom.build({
    selector: "#calendarZoneSelect",
    tag: "BUTTON",
    id: "calendarZoneSelect",
    text: "本地时间",
    rect: { x: 10, y: 20, width: 112, height: 30 },
    descendants: [
      {
        tag: "SPAN",
        className: "calendar-zone-arrow",
        rect: { x: 100, y: 30, width: 8, height: 8 },
        inline: { visibility: "collapse", "visibility!priority": "important" },
      },
    ],
  });
  const zoneArrow = zone.querySelector(".calendar-zone-arrow");
  const zoneProbe = runInNewContext(
    buildProbeSource("node-probe", "#calendarZoneSelect", null, null, true),
    dom.sandbox,
  );
  const zoneHide = runInNewContext(
    buildProbeSource("hide", "#calendarZoneSelect", 0, "text", zoneProbe.attemptToken),
    dom.sandbox,
  );
  assert.equal(zoneHide.decorationIsolation.kind, "calendar-zone-arrow");
  assert.equal(zoneHide.decorationIsolation.installed, true);
  assert.equal(zoneHide.decorationIsolation.hostStable, true);
  assert.equal(zoneArrow.style.getPropertyValue("visibility"), "hidden");
  assert.equal(zoneArrow.style.getPropertyPriority("visibility"), "important");
  const zoneRestore = runInNewContext(buildProbeSource("restore", zoneHide.token), dom.sandbox);
  const zoneVerify = runInNewContext(buildProbeSource("verify", zoneHide.token), dom.sandbox);
  assert.equal(zoneRestore.inlineRestored, true);
  assert.equal(zoneRestore.decorationRestored, true);
  assert.equal(zoneVerify.decorationRestored, true);
  assert.equal(zoneArrow.style.getPropertyValue("visibility"), "collapse");
  assert.equal(zoneArrow.style.getPropertyPriority("visibility"), "important");

  const marker = "data-skin-palette-measurement-decoration";
  const filled = dom.build({
    selector: "#modelComparisonSearch",
    tag: "INPUT",
    id: "modelComparisonSearch",
    type: "search",
    field: true,
    value: "needle",
    attributes: { [marker]: "existing-marker" },
    rect: { x: 10, y: 70, width: 180, height: 36 },
    textRects: [{ x: 11, y: 71, width: 178, height: 34 }],
  });
  filled.focus();
  const filledProbe = runInNewContext(
    buildProbeSource("node-probe", "#modelComparisonSearch", null, null, true),
    dom.sandbox,
  );
  const filledHide = runInNewContext(
    buildProbeSource("hide", "#modelComparisonSearch", 0, "text", filledProbe.attemptToken),
    dom.sandbox,
  );
  assert.equal(filledHide.decorationIsolation.kind, "search-cancel-button");
  assert.equal(filledHide.decorationIsolation.installed, true);
  assert.equal(filledHide.decorationIsolation.hadValue, true);
  assert.equal(filledHide.decorationIsolation.wasFocused, true);
  assert.equal(filledHide.decorationIsolation.businessStateUnchanged, true);
  assert.notEqual(filled.getAttribute(marker), "existing-marker", "隔离期间用会话 token 暂代原 marker");
  assert.match(dom.styleNodes.at(-1).textContent, /::-webkit-search-cancel-button\{visibility:hidden!important\}/);
  assert.equal(filled.value, "needle", "不得改写 search 值");
  assert.equal(dom.sandbox.document.activeElement, filled, "不得移走输入焦点");
  const filledRestore = runInNewContext(buildProbeSource("restore", filledHide.token), dom.sandbox);
  const filledVerify = runInNewContext(buildProbeSource("verify", filledHide.token), dom.sandbox);
  assert.equal(filledRestore.decorationRestored, true);
  assert.equal(filledVerify.decorationRestored, true);
  assert.equal(filled.getAttribute(marker), "existing-marker", "原 marker 值必须原样恢复");
  assert.equal(dom.styleNodes.at(-1).isConnected, false, "临时规则必须移除");
  assert.equal(filled.value, "needle");
  assert.equal(dom.sandbox.document.activeElement, filled);

  const empty = dom.build({
    selector: "#emptySearch",
    tag: "INPUT",
    id: "emptySearch",
    type: "search",
    field: true,
    value: "",
    rect: { x: 10, y: 120, width: 180, height: 36 },
  });
  empty.focus();
  const emptyProbe = runInNewContext(buildProbeSource("node-probe", "#emptySearch", null, null, true), dom.sandbox);
  const emptyHide = runInNewContext(
    buildProbeSource("hide", "#emptySearch", 0, "text", emptyProbe.attemptToken),
    dom.sandbox,
  );
  assert.equal(emptyHide.decorationIsolation.hadValue, false, "空输入不记录输入内容或伪造清除按钮");
  assert.equal(emptyHide.decorationIsolation.businessStateUnchanged, true);
  assert.deepEqual(hostValue(emptyHide.decorationIsolation), {
    kind: "search-cancel-button",
    installed: true,
    hostStable: true,
    businessStateUnchanged: true,
    hadValue: false,
    wasFocused: true,
    diagnosticLimit: "Edge 的 search 伪元素 CSSOM visibility 只作诊断；不作为绘制状态判据。",
  });
  dom.styleNodes.at(-1).remove = () => {
    throw new Error("one cleanup path failed");
  };
  const release = runInNewContext(buildProbeSource("release-attempt", emptyProbe.attemptToken), dom.sandbox);
  assert.equal(release.ok, false, "清理主路径失败必须进入诊断结果");
  assert.match(hostValue(release.failures).join(" "), /style\.remove: one cleanup path failed/);
  assert.equal(empty.hasAttribute(marker), false);
  assert.equal(dom.styleNodes.at(-1).isConnected, false, "备用 removeChild 必须清掉规则，不能污染后续角色");
  assert.equal(empty.value, "");
  assert.equal(dom.sandbox.document.activeElement, empty);

  const otherButton = dom.build({
    selector: "#otherButton",
    tag: "BUTTON",
    id: "otherButton",
    text: "Other",
    rect: { x: 200, y: 20, width: 60, height: 30 },
    descendants: [
      {
        tag: "SPAN",
        className: "calendar-zone-arrow",
        attributes: { "aria-hidden": "true" },
        rect: { x: 220, y: 30, width: 8, height: 8 },
      },
    ],
  });
  void otherButton;
  const otherArrow = otherButton.querySelector(".calendar-zone-arrow");
  const otherProbe = runInNewContext(buildProbeSource("node-probe", "#otherButton", null, null, true), dom.sandbox);
  const otherHide = runInNewContext(
    buildProbeSource("hide", "#otherButton", 0, "text", otherProbe.attemptToken),
    dom.sandbox,
  );
  assert.equal(otherHide.decorationIsolation, null, "不扩展到其它 aria-hidden 图标");
  assert.equal(otherArrow.style.getPropertyValue("visibility"), "");
  assert.equal(otherArrow.hasAttribute("aria-hidden"), true);
});

test("M5.2.C-D2a：遮挡探针记录五点身份，并区分宿主后代与外部覆盖层", () => {
  const dom = createElementStubDom();
  const host = dom.build({
    selector: ".target",
    tag: "BUTTON",
    id: "target-host",
    className: "target-control",
    rect: { x: 10, y: 20, width: 20, height: 10 },
    text: "PRIVATE_HOST_TEXT",
    descendants: [
      {
        tag: "SPAN",
        id: "target-label",
        className: "label",
        rect: { x: 12, y: 22, width: 16, height: 6 },
        text: "PRIVATE_CHILD_TEXT",
      },
    ],
  });
  const overlay = dom.build({
    selector: ".overlay",
    tag: "DIV",
    id: "modal-overlay",
    className: "outside-overlay",
    rect: { x: 28, y: 20, width: 10, height: 10 },
    text: "PRIVATE_OVERLAY_TEXT",
  });
  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  const child = host.querySelectorAll("*")[0];
  dom.setHitTest((x, y) => {
    if (x === 20 && y === 25) return child;
    if (x === 12 && y === 22) return host;
    if ((x === 28 && y === 22) || (x === 12 && y === 28)) return overlay;
    return null;
  });

  const result = runInNewContext(
    buildProbeSource("occlusion-probe", ".target", 0, [{ x: 10, y: 20, width: 20, height: 10 }], hide.token),
    dom.sandbox,
  );
  const points = hostValue(result.rects[0].points);
  assert.equal(points.length, 5, "中心与四个内缩角各命中一次");
  assert.deepEqual(
    points.map((point) => point.withinHost),
    [true, true, false, false, false],
  );
  assert.equal(points[0].top.tag, "span");
  assert.equal(points[1].top.identityId, probe.nodes[0].identityId, "宿主 hit target 复用节点探测身份");
  assert.notEqual(points[0].top.identityId, points[1].top.identityId, "宿主后代保留独立 DOM 身份");
  assert.equal(points[1].top.id, "target-host");
  assert.equal(points[2].top.id, "modal-overlay");
  assert.equal(points[2].top.className, "outside-overlay");
  assert.deepEqual(hostValue(result.scroll), { x: 0, y: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:HOST|CHILD|OVERLAY)_TEXT/);
});

test("M5.2.C-D2b1：圆角输入框的五点探针落在实际宿主内", () => {
  const dom = createElementStubDom();
  const host = dom.build({
    selector: ".rounded",
    tag: "INPUT",
    field: true,
    id: "rounded-control",
    rect: { x: 10, y: 20, width: 180, height: 36 },
    clientWidth: 178,
    clientHeight: 34,
  });
  host.clientLeft = 1;
  host.clientTop = 1;
  const baseGetComputedStyle = dom.sandbox.getComputedStyle;
  dom.sandbox.getComputedStyle = (element, pseudo) => ({
    ...baseGetComputedStyle(element, pseudo),
    ...(element === host && !pseudo
      ? {
          borderTopLeftRadius: "11px",
          borderTopRightRadius: "11px",
          borderBottomLeftRadius: "11px",
          borderBottomRightRadius: "11px",
        }
      : {}),
  });
  const probe = runInNewContext(buildProbeSource("node-probe", ".rounded", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".rounded", 0, "text", probe.attemptToken), dom.sandbox);
  const radius = 11;
  dom.setHitTest((x, y) => {
    const nearestX = Math.max(10 + radius, Math.min(x, 190 - radius));
    const nearestY = Math.max(20 + radius, Math.min(y, 56 - radius));
    return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2 ? host : null;
  });

  const result = runInNewContext(
    buildProbeSource("occlusion-probe", ".rounded", 0, [{ x: 11, y: 21, width: 178, height: 34 }], hide.token),
    dom.sandbox,
  );
  const points = hostValue(result.rects[0].points);
  assert.equal(points.length, 5, "圆角修正仍检查中心和四个角点");
  assert.ok(
    points.every((point) => point.withinHost),
    "五点都应命中圆角输入框本身",
  );
  assert.deepEqual(
    points.slice(1).map(({ kind, x, y, top, withinHost }) => ({ kind, x, y, top: top.id, withinHost })),
    [
      { kind: "topLeft", x: 15, y: 25, top: "rounded-control", withinHost: true },
      { kind: "topRight", x: 185, y: 25, top: "rounded-control", withinHost: true },
      { kind: "bottomLeft", x: 15, y: 51, top: "rounded-control", withinHost: true },
      { kind: "bottomRight", x: 185, y: 51, top: "rounded-control", withinHost: true },
    ],
  );
});

test("M3.2 返工回归：旧接口 restore/verify 分支保持可用——selector/index 直取，不得删用例规避", () => {
  const dom = createElementStubDom();
  dom.build({
    selector: ".target",
    rect: { x: 10, y: 20, width: 100, height: 18 },
    inline: { color: "rgb(1, 2, 3)" },
  });

  // 旧签名（selector, index[, originals]）在正式模块里必须仍然走"直取元素"分支。
  // 只加 token 分支而让旧分支引用不存在的 selector 会在这里直接抛 ReferenceError。
  const restoreSource = buildProbeSource("restore", ".target", 0, {});
  assert.match(restoreSource, /\/\/ skinProbe: restore/);
  assert.ok(restoreSource.includes(JSON.stringify(".target")), "旧接口分支必须用传入的 selector 定位元素");
  assert.equal(runInNewContext(restoreSource, dom.sandbox).ok, true, "旧接口 restore 不得抛 selector is not defined");

  const verifySource = buildProbeSource("verify", ".target", 0);
  assert.match(verifySource, /\/\/ skinProbe: verify/);
  assert.ok(verifySource.includes(JSON.stringify(".target")), "旧接口分支必须用传入的 selector 定位元素");
  const verify = runInNewContext(verifySource, dom.sandbox);
  assert.equal(verify.ok, true, "旧接口 verify 不得抛 selector is not defined");
  assert.equal(verify.after.color, "rgb(1, 2, 3)", "旧接口 verify 仍回报恢复后快照");
  assert.equal(verify.after.rect.width, 100);

  // 旧接口 hide 同样保留（selector, index, mode）
  const hide = runInNewContext(buildProbeSource("hide", ".target", 0, "text"), dom.sandbox);
  assert.equal(hide.ok, true);
  assert.equal(hide.token, undefined, "旧接口不写页内暂存，不返回 token");
  const roundTrip = runInNewContext(buildProbeSource("restore", ".target", 0, hide.originals), dom.sandbox);
  assert.equal(roundTrip.ok, true);
});

test("M3.2 返工回归：角色尝试基准在开始时固定——已测位次被换/数量变化都判定整轮失效", () => {
  const dom = createElementStubDom();
  const spec = () => ({
    selector: ".target",
    rect: { x: 10, y: 20, width: 100, height: 18 },
    inline: { color: "rgb(69, 86, 102)" },
  });
  const first = dom.build(spec());
  dom.build(spec());

  // 尝试开始：探测建立基准并回报 attemptToken / identityId
  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  assert.equal(probe.nodes.length, 2);
  assert.ok(probe.attemptToken, "开启身份跟踪时必须回报本次尝试的基准 token");
  assert.deepEqual(hostValue(probe.nodes.map((node) => node.identityId)), [1, 2], "逐元素分配稳定身份号");

  // 第一个节点完整走一轮：隐藏 → 恢复 → 核验
  const hide0 = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide0.ok, true);
  assert.ok(hide0.token, "正式路径隐藏样本写进页内暂存并回报 token");
  const restore0 = runInNewContext(buildProbeSource("restore", hide0.token), dom.sandbox);
  assert.equal(restore0.ok, true);
  assert.equal(restore0.identityValid, true);
  assert.equal(restore0.inlineRestored, true, "内联声明逐属性回到原值");
  const verify0 = runInNewContext(buildProbeSource("verify", hide0.token), dom.sandbox);
  assert.equal(verify0.ok, true);
  assert.equal(verify0.identityValid, true);
  assert.equal(verify0.inlineRestored, true);

  // 已测成员被替换：第二个节点的隐藏必须判定整轮失效（不得按当前 DOM 刷新基准）
  const clone = dom.build(spec());
  dom.replace(first, clone);
  const hide1 = runInNewContext(buildProbeSource("hide", ".target", 1, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide1.ok, false);
  assert.equal(hide1.identityInvalid, true, "已测位次换成新节点必须判定身份失效");
  assert.match(hide1.reason, /第 0 位已换成新节点/);

  // 隐藏后基准里那一份被换掉：恢复/核验要回报 identityValid=false，不假装还原成功
  const second = dom.elements[1];
  const hideA = runInNewContext(buildProbeSource("hide", ".target", 1, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hideA.ok, false, "基准已失效时隐藏直接拒绝");

  // 新尝试从当前完整快照重建基准，数量变化同样判定失效
  const probe2 = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  assert.equal(probe2.nodes.length, 2);
  const hideB = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe2.attemptToken), dom.sandbox);
  assert.equal(hideB.ok, true);
  assert.equal(runInNewContext(buildProbeSource("restore", hideB.token), dom.sandbox).identityValid, true);
  const verifyB = runInNewContext(buildProbeSource("verify", hideB.token), dom.sandbox);
  assert.equal(verifyB.identityValid, true);

  dom.build(spec());
  const hideC = runInNewContext(buildProbeSource("hide", ".target", 1, "text", probe2.attemptToken), dom.sandbox);
  assert.equal(hideC.ok, false);
  assert.equal(hideC.identityInvalid, true, "匹配集合数量变化必须判定身份失效");
  assert.match(hideC.reason, /数量已变化（2 → 3）/);
  assert.ok(second, "第二个节点引用在替换后仍可读（测试自身不依赖它）");

  // 逐带重探（带隐藏样本的 node-probe）与像素扫描也必须带同一份基准
  const live = runInNewContext(buildProbeSource("node-probe", ".target", null, null, false), dom.sandbox);
  assert.equal(live.measurementIdentity, null, "不带隐藏样本的探测不做身份核验");
  const hideD = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe2.attemptToken), dom.sandbox);
  assert.equal(hideD.ok, false, "数量变化后基准持续失效（同一尝试内不再自愈）");
});

test("B34：三个动态文字 host 的 Text node/内容/Range 快照必须可复查且失效仍恢复", async () => {
  const selector = "#lastSuccessfulCheck";
  const rect = { x: 10, y: 20, width: 120, height: 20 };
  const textRect = { x: 14, y: 23, width: 72, height: 15 };
  const text = "上次：12:00";
  const buildTarget = (dom, textNode = { nodeType: 3, data: text, textContent: text, _textRects: [textRect] }) =>
    dom.build({
      selector,
      tag: "SPAN",
      id: "lastSuccessfulCheck",
      rect,
      textRects: [textRect],
      childNodes: [textNode],
    });
  const start = (dom) => runInNewContext(buildProbeSource("node-probe", selector, null, null, true), dom.sandbox);
  const live = (dom, token) =>
    runInNewContext(buildProbeSource("node-probe", selector, null, token, false), dom.sandbox);

  const changedNodeDom = createElementStubDom();
  const changedNodeTarget = buildTarget(changedNodeDom);
  const changedNodeProbe = start(changedNodeDom);
  assert.deepEqual(hostValue(changedNodeProbe.nodes[0].dynamicTextSnapshot), {
    valid: true,
    reason: null,
    textNodeCount: 1,
    nodes: [
      {
        index: 0,
        text,
        start: { offset: 0 },
        end: { offset: text.length },
        rects: [{ x: 4, y: 3, width: 72, height: 15 }],
      },
    ],
  });
  const changedNodeHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", changedNodeProbe.attemptToken),
    changedNodeDom.sandbox,
  );
  assert.equal(changedNodeHide.ok, true);
  changedNodeTarget.childNodes = [
    { nodeType: 3, data: "上次：13:00", textContent: "上次：13:00", _textRects: [textRect] },
  ];
  const changedNodeLive = live(changedNodeDom, changedNodeHide.token);
  assert.equal(changedNodeLive.measurementIdentity.valid, false);
  assert.match(changedNodeLive.measurementIdentity.reason, /已换成新节点/);
  const changedNodeRestore = runInNewContext(
    buildProbeSource("restore", changedNodeHide.token),
    changedNodeDom.sandbox,
  );
  assert.equal(changedNodeRestore.ok, true, "identity 失效时恢复分支仍必须执行");
  assert.equal(changedNodeRestore.identityValid, false);
  assert.equal(changedNodeRestore.inlineRestored, true);
  assert.equal(changedNodeTarget.style.getPropertyValue("-webkit-text-fill-color"), "");
  const changedNodeRelease = runInNewContext(
    buildProbeSource("release-attempt", changedNodeProbe.attemptToken),
    changedNodeDom.sandbox,
  );
  assert.equal(changedNodeRelease.attemptReleased, true);

  const asOfDom = createElementStubDom();
  const asOfSelector = ".comparison-as-of";
  const asOfA = asOfDom.build({
    selector: asOfSelector,
    tag: "P",
    className: "comparison-as-of",
    rect,
    textRects: [textRect],
    childNodes: [{ nodeType: 3, data: "统计截至 12:00", textContent: "统计截至 12:00", _textRects: [textRect] }],
  });
  const asOfB = asOfDom.build({
    selector: asOfSelector,
    tag: "P",
    className: "comparison-as-of",
    rect,
    textRects: [textRect],
    childNodes: [{ nodeType: 3, data: "统计截至 12:00", textContent: "统计截至 12:00", _textRects: [textRect] }],
  });
  const asOfProbe = runInNewContext(buildProbeSource("node-probe", asOfSelector, null, null, true), asOfDom.sandbox);
  assert.ok(asOfProbe.nodes.every((node) => node.dynamicTextSnapshot?.valid === true));
  const asOfHide = runInNewContext(
    buildProbeSource("hide", asOfSelector, 0, "text", asOfProbe.attemptToken),
    asOfDom.sandbox,
  );
  assert.equal(asOfHide.ok, true);
  asOfB.childNodes[0].data = "统计截至 13:00";
  const asOfLive = runInNewContext(
    buildProbeSource("node-probe", asOfSelector, null, asOfHide.token, false),
    asOfDom.sandbox,
  );
  assert.equal(asOfLive.measurementIdentity.valid, false);
  assert.match(asOfLive.measurementIdentity.reason, /第 1 位宿主.*内容已变化/);
  assert.ok(asOfA.childNodes[0].data.startsWith("统计截至"));

  const textDataDom = createElementStubDom();
  const textDataTarget = buildTarget(textDataDom);
  const textDataProbe = start(textDataDom);
  const textDataHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", textDataProbe.attemptToken),
    textDataDom.sandbox,
  );
  assert.equal(live(textDataDom, textDataHide.token).measurementIdentity.valid, true, "paint-only 隐藏不误报");
  textDataTarget.childNodes[0].data = "上次：13:00";
  const png = createPngStubDom({ width: 120, height: 20, fill: () => [255, 255, 255, 255] });
  const scanSandbox = {
    ...textDataDom.sandbox,
    document: { ...textDataDom.sandbox.document, createElement: png.sandbox.document.createElement },
    Image: png.sandbox.Image,
  };
  const textDataScan = await runInNewContext(
    buildProbeSource(
      "scan",
      "png",
      [{ id: "r0", x: 10, y: 20, width: 20, height: 20 }],
      { x: 0, y: 0, width: 120, height: 20 },
      textDataHide.token,
    ),
    scanSandbox,
  );
  assert.equal(textDataScan.identityValid, false);
  assert.match(textDataScan.reason, /内容已变化/);
  assert.deepEqual(hostValue(textDataScan.regions), []);

  const rangeDom = createElementStubDom();
  const rangeTarget = buildTarget(rangeDom);
  const rangeProbe = start(rangeDom);
  const rangeHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", rangeProbe.attemptToken),
    rangeDom.sandbox,
  );
  rangeTarget._rect = { ...rect, y: rect.y + 120 };
  rangeTarget.childNodes[0]._textRects = [{ ...textRect, y: textRect.y + 120 }];
  assert.equal(live(rangeDom, rangeHide.token).measurementIdentity.valid, true, "普通滚动不应误报");
  rangeTarget.childNodes[0]._textRects = [{ ...textRect, x: textRect.x + 130, y: textRect.y + 120 }];
  const shifted = live(rangeDom, rangeHide.token);
  assert.equal(shifted.measurementIdentity.valid, false);
  assert.match(shifted.measurementIdentity.reason, /Range 边界已变化/);

  const emptyRangeDom = createElementStubDom();
  buildTarget(emptyRangeDom, { nodeType: 3, data: text, textContent: text, _textRects: [] });
  const emptyRangeProbe = start(emptyRangeDom);
  assert.equal(emptyRangeProbe.nodes[0].dynamicTextSnapshot.valid, false);
  assert.match(emptyRangeProbe.nodes[0].dynamicTextSnapshot.reason, /Range 为空/);
  const emptyRangeHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", emptyRangeProbe.attemptToken),
    emptyRangeDom.sandbox,
  );
  assert.equal(emptyRangeHide.identityInvalid, true);

  const throwingRangeDom = createElementStubDom();
  const throwingRangeTarget = buildTarget(throwingRangeDom);
  const throwingRangeProbe = start(throwingRangeDom);
  const throwingRangeHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", throwingRangeProbe.attemptToken),
    throwingRangeDom.sandbox,
  );
  Object.defineProperty(throwingRangeTarget.childNodes[0], "_textRects", {
    configurable: true,
    get() {
      throw new Error("Range recheck exploded");
    },
  });
  const throwingRangeLive = live(throwingRangeDom, throwingRangeHide.token);
  assert.equal(throwingRangeLive.measurementIdentity.valid, false);
  assert.match(throwingRangeLive.measurementIdentity.reason, /Range 复查失败/);

  const cleanDom = createElementStubDom();
  buildTarget(cleanDom);
  const cleanProbe = start(cleanDom);
  const cleanHide = runInNewContext(
    buildProbeSource("hide", selector, 0, "text", cleanProbe.attemptToken),
    cleanDom.sandbox,
  );
  assert.equal(live(cleanDom, cleanHide.token).measurementIdentity.valid, true);
  assert.equal(runInNewContext(buildProbeSource("restore", cleanHide.token), cleanDom.sandbox).identityValid, true);
  assert.equal(runInNewContext(buildProbeSource("verify", cleanHide.token), cleanDom.sandbox).identityValid, true);
  const cleanRelease = runInNewContext(buildProbeSource("release-attempt", cleanProbe.attemptToken), cleanDom.sandbox);
  assert.equal(cleanRelease.attemptReleased, true);
});

test("B34-R1：复查先拒绝非正 Range 面积，不能借 0.01 容差放行", () => {
  const selector = "#lastSuccessfulCheck";
  const hostRect = { x: 10, y: 20, width: 120, height: 20 };
  const tinyRect = { x: 14, y: 23, width: 0.005, height: 0.005 };
  const assertRejected = (recheckWidth) => {
    const dom = createElementStubDom();
    const target = dom.build({
      selector,
      tag: "SPAN",
      id: "lastSuccessfulCheck",
      rect: hostRect,
      textRects: [tinyRect],
      childNodes: [{ nodeType: 3, data: "上次：12:00", textContent: "上次：12:00", _textRects: [tinyRect] }],
    });
    const probe = runInNewContext(buildProbeSource("node-probe", selector, null, null, true), dom.sandbox);
    assert.equal(probe.nodes[0].dynamicTextSnapshot.valid, true, "初始极小正面积快照成立");
    const hide = runInNewContext(buildProbeSource("hide", selector, 0, "text", probe.attemptToken), dom.sandbox);
    target.childNodes[0]._textRects = [{ ...tinyRect, width: recheckWidth }];
    const live = runInNewContext(buildProbeSource("node-probe", selector, null, hide.token, false), dom.sandbox);
    assert.equal(live.measurementIdentity.valid, false);
    assert.match(live.measurementIdentity.reason, /Range 几何无效/);
  };
  assertRejected(0);
  assertRejected(-0.005);
});

test("M3.2 返工回归：宿主不变只换子节点也判失效；隐藏后仍有元素画字则判隔离失败", () => {
  const dom = createElementStubDom();
  const buttonSpec = (spanInline = {}) => ({
    tag: "BUTTON",
    rect: { x: 12, y: 22, width: 100, height: 20 },
    descendants: [{ tag: "SPAN", text: "First", rect: { x: 14, y: 24, width: 40, height: 16 }, inline: spanInline }],
  });
  const hostSpec = (descendants) => ({
    selector: ".target",
    tag: "TH",
    rect: { x: 10, y: 20, width: 120, height: 24 },
    inline: { color: "rgb(69, 86, 102)" },
    descendants,
  });
  const host = dom.build(hostSpec([buttonSpec()]));
  dom.build(hostSpec([buttonSpec()]));

  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  assert.equal(probe.nodes.length, 2);
  const hide = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide.ok, true);
  // 宿主写了 transparent，span 继承它 → 整棵文字层确实没在画
  assert.equal(hide.isolation.isolated, true, "继承隐藏生效时隔离判定为有效");
  assert.deepEqual(hostValue(hide.isolation.remaining), []);

  // 宿主对象不变、只把 button 换成新对象：同样是换了一个 DOM 版本
  const button = host._descendants[0];
  const rebuilt = dom.build(buttonSpec());
  dom.replaceIn(host, button, rebuilt);
  assert.equal(dom.elements.includes(host), true, "宿主对象保持原引用");
  const hideChild = runInNewContext(buildProbeSource("hide", ".target", 1, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hideChild.ok, false, "只换子节点也必须判整轮失效");
  assert.equal(hideChild.identityInvalid, true);
  assert.match(hideChild.reason, /第 0 位宿主的第 0 个子节点已换成新节点/);

  // 新尝试里子节点自带非透明填充：宿主写 transparent 也压不住它 → 隔离失败。
  // 这里只改同一个 span 对象的内联声明（对象身份不变），测的才是"隔离"而非"身份"。
  const probe2 = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const explicitHost = dom.elements.filter((element) => element._selector === ".target")[1];
  const explicitSpan = explicitHost._descendants[0]._descendants[0];
  explicitSpan.style.setProperty("-webkit-text-fill-color", "rgb(69, 86, 102)");
  const hideExplicit = runInNewContext(
    buildProbeSource("hide", ".target", 1, "text", probe2.attemptToken),
    dom.sandbox,
  );
  assert.equal(hideExplicit.ok, true, "身份没变，隐藏照常执行");
  assert.equal(hideExplicit.isolation.isolated, false, "子节点自带填充时隔离必须判失败");
  assert.deepEqual(hostValue(hideExplicit.isolation.remaining), ["span"], "原因要点出还在画字的后代");
  assert.equal(
    runInNewContext(buildProbeSource("restore", hideExplicit.token), dom.sandbox).ok,
    true,
    "隔离失败也要能正常恢复",
  );
});

test("M3.2 返工回归：收尾源按尝试 token 恢复样式并释放暂存，不误删别的会话", () => {
  const dom = createElementStubDom();
  const spec = () => ({
    selector: ".target",
    rect: { x: 10, y: 20, width: 100, height: 18 },
    inline: { color: "rgb(69, 86, 102)" },
  });
  const first = dom.build(spec());
  const second = dom.build(spec());
  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hide0 = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  const hide1 = runInNewContext(buildProbeSource("hide", ".target", 1, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide0.ok, true);
  assert.equal(hide1.ok, true);
  // 另一次尝试的会话：收尾只按自己的 token 清，不能连它一起删
  const otherProbe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hideOther = runInNewContext(
    buildProbeSource("hide", ".target", 1, "text", otherProbe.attemptToken),
    dom.sandbox,
  );
  assert.equal(hideOther.ok, true);
  assert.equal(first.style.getPropertyValue("-webkit-text-fill-color"), "transparent", "隐藏已写进内联声明");

  const released = runInNewContext(buildProbeSource("release-attempt", probe.attemptToken), dom.sandbox);
  assert.equal(released.ok, true);
  assert.equal(released.restoredTargets, 2, "本次尝试的两个隐藏目标都要补恢复");
  assert.equal(released.releasedSessions, 2);
  assert.equal(released.attemptReleased, true, "尝试基准本身也要释放（强引用）");
  // 样式必须真的回到原值（原本为空 → 移除），不是只丢引用
  assert.equal(first.style.getPropertyValue("-webkit-text-fill-color"), "");
  assert.equal(first.style.getPropertyValue("text-shadow"), "");
  assert.equal(second.style.getPropertyValue("-webkit-text-fill-color"), "");
  // 别的尝试的会话仍然可用：证明是按 token 清，不是清空整张表
  const verifyOther = runInNewContext(buildProbeSource("verify", hideOther.token), dom.sandbox);
  assert.equal(verifyOther.ok, true, "别的尝试的隐藏样本不得被误删");
  assert.equal(verifyOther.identityValid, true);

  // 同一 token 再收尾一次是幂等的（不抛、不再报补恢复）
  const again = runInNewContext(buildProbeSource("release-attempt", probe.attemptToken), dom.sandbox);
  assert.deepEqual(hostValue(again), { ok: true, restoredTargets: 0, releasedSessions: 0, attemptReleased: false });
});

test("M3.2 返工回归：逐带重探与像素扫描都拿角色尝试基准核验——中途换集合即判失效", async () => {
  const dom = createElementStubDom();
  const spec = () => ({
    selector: ".target",
    rect: { x: 10, y: 20, width: 100, height: 18 },
    inline: { color: "rgb(69, 86, 102)" },
  });
  dom.build(spec());
  dom.build(spec());
  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide.ok, true);

  // 逐带重探：集合没变 → 正常回报节点
  const liveOk = runInNewContext(buildProbeSource("node-probe", ".target", null, hide.token, false), dom.sandbox);
  assert.equal(liveOk.nodes.length, 2);
  assert.equal(liveOk.measurementIdentity.valid, true);

  // 集合被换掉 → 逐带重探不带回节点，并说明原因（Node 侧据此抛样本失效）
  const clone = dom.build(spec());
  dom.replace(dom.elements[0], clone);
  const liveBad = runInNewContext(buildProbeSource("node-probe", ".target", null, hide.token, false), dom.sandbox);
  assert.deepEqual(hostValue(liveBad.nodes), [], "身份失效时逐带重探不得把新集合当成同一批样本");
  assert.equal(liveBad.measurementIdentity.valid, false);
  assert.match(liveBad.measurementIdentity.reason, /第 0 位已换成新节点/);

  // 像素扫描：解码后核验同一份基准，失效就不带像素回来
  const png = createPngStubDom({ width: 4, height: 4, fill: () => [255, 255, 255, 255] });
  const scanSandbox = {
    window: dom.sandbox.window,
    document: { ...dom.sandbox.document, createElement: png.sandbox.document.createElement },
    getComputedStyle: dom.sandbox.getComputedStyle,
    HTMLInputElement: dom.sandbox.HTMLInputElement,
    HTMLTextAreaElement: dom.sandbox.HTMLTextAreaElement,
    SVGElement: dom.sandbox.SVGElement,
    Image: png.sandbox.Image,
  };
  const scanRegion = [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }];
  const scanClip = { x: 0, y: 0, width: 4, height: 4 };
  const scanOk = await runInNewContext(
    buildProbeSource("scan", "png-base64", scanRegion, scanClip, hide.token),
    scanSandbox,
  );
  assert.equal(scanOk.identityValid, false, "扫描时基准已失效必须回报 identityValid=false");
  assert.deepEqual(hostValue(scanOk.regions), [], "失效样本不得带像素回来");
  assert.match(scanOk.reason, /第 0 位已换成新节点/);

  // 基准未失效时扫描照常带像素回来（同一份暂存里重新建立尝试）
  const probeAgain = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hideAgain = runInNewContext(
    buildProbeSource("hide", ".target", 0, "text", probeAgain.attemptToken),
    dom.sandbox,
  );
  assert.equal(hideAgain.ok, true);
  const scanValid = await runInNewContext(
    buildProbeSource("scan", "png-base64", scanRegion, scanClip, hideAgain.token),
    scanSandbox,
  );
  assert.equal(scanValid.identityValid, true);
  assert.equal(scanValid.regions.length, 1, "基准有效时扫描照常回报区域像素");

  // 不带隐藏样本的扫描不核验身份（旧口径保持不变）
  const scanLegacy = await runInNewContext(
    buildProbeSource("scan", "png-base64", [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }], {
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    }),
    png.sandbox,
  );
  assert.equal(scanLegacy.identityValid, null);
  assert.equal(scanLegacy.regions.length, 1);
});

test("M3.2 返工回归：扫描源在解码后复核隔离——同一对象晚期拿到文字填充即拒绝像素", async () => {
  const dom = createElementStubDom();
  const target = dom.build({
    selector: ".target",
    text: "First",
    rect: { x: 0, y: 0, width: 4, height: 4 },
    inline: { color: "rgb(69, 86, 102)" },
  });
  const probe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), dom.sandbox);
  const hide = runInNewContext(buildProbeSource("hide", ".target", 0, "text", probe.attemptToken), dom.sandbox);
  assert.equal(hide.ok, true);
  assert.equal(hide.isolation.isolated, true, "隐藏刚写完时隔离是有效的");

  // 关键：**同一个对象**（不换节点、数量不变）在隐藏检查之后重新拿到显式填充
  target.style.setProperty("-webkit-text-fill-color", "rgb(69, 86, 102)");

  const png = createPngStubDom({ width: 4, height: 4, fill: () => [255, 255, 255, 255] });
  const scanSandbox = {
    window: dom.sandbox.window,
    document: { ...dom.sandbox.document, createElement: png.sandbox.document.createElement },
    getComputedStyle: dom.sandbox.getComputedStyle,
    HTMLInputElement: dom.sandbox.HTMLInputElement,
    HTMLTextAreaElement: dom.sandbox.HTMLTextAreaElement,
    SVGElement: dom.sandbox.SVGElement,
    Image: png.sandbox.Image,
  };
  const scan = await runInNewContext(
    buildProbeSource(
      "scan",
      "png-base64",
      [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }],
      {
        x: 0,
        y: 0,
        width: 4,
        height: 4,
      },
      hide.token,
    ),
    scanSandbox,
  );
  assert.equal(scan.identityValid, true, "对象没换、数量没变 → 身份核验仍然有效");
  assert.equal(scan.isolationValid, false, "解码后复核必须发现隔离已经失效");
  assert.match(scan.isolationReason, /隐藏后仍检测到文字绘制/);
  assert.match(scan.isolationReason, /div/);
  assert.deepEqual(hostValue(scan.regions), [], "污染样本不得带像素回来");

  // 隔离仍然有效时照常回报像素（新检查不得挡掉好样本）
  const clean = createElementStubDom();
  const cleanTarget = clean.build({
    selector: ".target",
    text: "First",
    rect: { x: 0, y: 0, width: 4, height: 4 },
    inline: { color: "rgb(69, 86, 102)" },
  });
  void cleanTarget;
  const cleanProbe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), clean.sandbox);
  const cleanHide = runInNewContext(
    buildProbeSource("hide", ".target", 0, "text", cleanProbe.attemptToken),
    clean.sandbox,
  );
  const cleanSandbox = {
    window: clean.sandbox.window,
    document: { ...clean.sandbox.document, createElement: png.sandbox.document.createElement },
    getComputedStyle: clean.sandbox.getComputedStyle,
    HTMLInputElement: clean.sandbox.HTMLInputElement,
    HTMLTextAreaElement: clean.sandbox.HTMLTextAreaElement,
    SVGElement: clean.sandbox.SVGElement,
    Image: png.sandbox.Image,
  };
  const cleanScan = await runInNewContext(
    buildProbeSource(
      "scan",
      "png-base64",
      [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }],
      {
        x: 0,
        y: 0,
        width: 4,
        height: 4,
      },
      cleanHide.token,
    ),
    cleanSandbox,
  );
  assert.equal(cleanScan.identityValid, true);
  assert.equal(cleanScan.isolationValid, true);
  assert.equal(cleanScan.regions.length, 1, "隔离有效时照常回报区域像素");

  // surface 模式：自身 background-color 被写回来同样判隔离失效
  const surfaceDom = createElementStubDom();
  const surfaceTarget = surfaceDom.build({
    selector: ".target",
    rect: { x: 0, y: 0, width: 4, height: 4 },
    inline: { backgroundColor: "rgb(69, 86, 102)" },
  });
  const surfaceProbe = runInNewContext(buildProbeSource("node-probe", ".target", null, null, true), surfaceDom.sandbox);
  const surfaceHide = runInNewContext(
    buildProbeSource("hide", ".target", 0, "surface", surfaceProbe.attemptToken),
    surfaceDom.sandbox,
  );
  assert.equal(surfaceHide.isolation.isolated, true, "清掉自身填充后隔离有效");
  surfaceTarget.style.setProperty("background-color", "rgb(69, 86, 102)");
  const surfaceSandbox = {
    window: surfaceDom.sandbox.window,
    document: { ...surfaceDom.sandbox.document, createElement: png.sandbox.document.createElement },
    getComputedStyle: surfaceDom.sandbox.getComputedStyle,
    HTMLInputElement: surfaceDom.sandbox.HTMLInputElement,
    HTMLTextAreaElement: surfaceDom.sandbox.HTMLTextAreaElement,
    SVGElement: surfaceDom.sandbox.SVGElement,
    Image: png.sandbox.Image,
  };
  const surfaceScan = await runInNewContext(
    buildProbeSource(
      "scan",
      "png-base64",
      [{ id: "r0", x: 0, y: 0, width: 4, height: 4 }],
      {
        x: 0,
        y: 0,
        width: 4,
        height: 4,
      },
      surfaceHide.token,
    ),
    surfaceSandbox,
  );
  assert.equal(surfaceScan.isolationValid, false, "自身填充被写回来也必须判隔离失效");
  assert.match(surfaceScan.isolationReason, /background-color/);
  assert.deepEqual(hostValue(surfaceScan.regions), []);
});

test("M3.2：伪元素选择器在页内不可解析——探测源返回错误而不是抛穿", () => {
  const dom = createElementStubDom();
  const probe = runInNewContext(buildProbeSource("node-probe", "input::placeholder", "::placeholder"), dom.sandbox);
  assert.ok(probe.error, "querySelectorAll 的伪元素 SyntaxError 被捕获为 error");
  assert.deepEqual(hostValue(probe.nodes), []);
});

/** canvas 绘图状态替身：记 save/restore 调用，按配置让 fillRect 抛异常。 */
function createCanvasStateStubDom({ throwOnFill = false } = {}) {
  const calls = [];
  class StubCtx {
    constructor(canvas) {
      this.canvas = canvas;
      this.fillStyle = "#000000";
      this.globalAlpha = 1;
      this.globalCompositeOperation = "source-over";
      this._transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      this._stack = [];
    }
    save() {
      calls.push("save");
      this._stack.push({
        transform: { ...this._transform },
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
      });
    }
    restore() {
      calls.push("restore");
      const state = this._stack.pop();
      if (!state) return;
      this._transform = state.transform;
      this.globalAlpha = state.globalAlpha;
      this.fillStyle = state.fillStyle;
    }
    setTransform(a, b, c, d, e, f) {
      this._transform = { a, b, c, d, e, f };
    }
    getTransform() {
      return { ...this._transform };
    }
    clearRect() {}
    fillRect() {
      if (throwOnFill) throw new Error("重建底色层失败");
    }
    putImageData() {}
    getImageData(_x, _y, width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    }
  }
  const canvas = { id: "timelineChart", width: 960, height: 320 };
  const ctx = new StubCtx(canvas);
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({ x: 40, y: 300, width: 400, height: 120 });
  const sandbox = {
    // 观察器替身按真实观察器的行为给值：没有记录帧边界时当前帧是 0
    window: { __skinPaletteColorObserver: { records: [], frameOf: () => 0 } },
    document: { querySelector: (selector) => (selector === "#timelineChart" ? canvas : null) },
  };
  return { sandbox, ctx, calls };
}

test("M3.2：canvas 清理与恢复保存并还原绘图状态——transform/alpha/填充不被测量改动", () => {
  const { sandbox, ctx, calls } = createCanvasStateStubDom();
  assert.equal(runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), sandbox).ok, true);
  // 应用自己的绘图状态（DPR=2 的 transform + 半透明 + 自定义填充）
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#abcdef";

  const cleared = runInNewContext(buildProbeSource("canvas-clear", []), sandbox);
  assert.equal(cleared.ok, true);
  assert.deepEqual(hostValue(ctx.getTransform()), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, "清理后 transform 必须还原");
  assert.equal(ctx.globalAlpha, 0.25, "清理后 globalAlpha 必须还原");
  assert.equal(ctx.fillStyle, "#abcdef", "清理后 fillStyle 必须还原");

  const restored = runInNewContext(buildProbeSource("canvas-restore"), sandbox);
  assert.equal(restored.identical, true);
  assert.deepEqual(
    hostValue(ctx.getTransform()),
    { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 },
    "恢复 bitmap 后 transform 必须还原",
  );
  assert.deepEqual(calls.filter((call) => call === "save").length >= 2, true, "清理与恢复都要入栈保存");
  assert.deepEqual(calls.filter((call) => call === "restore").length >= 2, true);
});

test("M3.2：重建底色层抛异常时绘图状态仍被还原（save/restore 包住清理阶段）", () => {
  const { sandbox, ctx, calls } = createCanvasStateStubDom({ throwOnFill: true });
  assert.equal(runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), sandbox).ok, true);
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.globalAlpha = 0.5;
  const baseFill = {
    method: "fillRect",
    fillStyle: "#123456",
    alpha: 1,
    rectArgs: [0, 0, 960, 320],
  };
  assert.throws(() => runInNewContext(buildProbeSource("canvas-clear", [baseFill]), sandbox), /重建底色层失败/);
  assert.deepEqual(hostValue(ctx.getTransform()), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, "异常路径也要还原 transform");
  assert.equal(ctx.globalAlpha, 0.5, "异常路径也要还原 alpha");
  assert.deepEqual(calls.includes("restore"), true, "finally 必须执行 restore");
});

/** 观察器 + 画布尺寸重置替身：StubCanvas 的 width/height 挂在原型上供重置补丁读取。 */
function createFrameObserverStubDom() {
  class StubCanvasElement {}
  Object.defineProperty(StubCanvasElement.prototype, "width", {
    get() {
      return this._width ?? 0;
    },
    set(value) {
      this._width = value;
    },
    configurable: true,
  });
  Object.defineProperty(StubCanvasElement.prototype, "height", {
    get() {
      return this._height ?? 0;
    },
    set(value) {
      this._height = value;
    },
    configurable: true,
  });
  class StubCtx {
    constructor(canvas) {
      this.canvas = canvas;
      this.fillStyle = "#000000";
      this.strokeStyle = "#000000";
      this.lineWidth = 1;
      this.globalAlpha = 1;
      this.globalCompositeOperation = "source-over";
      this.font = "10px sans-serif";
      this.textAlign = "start";
    }
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    }
    measureText(text) {
      return {
        width: String(text).length * 6,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 2,
      };
    }
    fillText() {}
    strokeText() {}
    stroke() {}
    fill() {}
    fillRect() {}
    clearRect() {}
    putImageData() {}
    getImageData(_x, _y, width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    }
  }
  const canvas = new StubCanvasElement();
  canvas.id = "timelineChart";
  canvas._width = 960;
  canvas._height = 320;
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({ x: 40, y: 300, width: 400, height: 120 });
  const ctx = new StubCtx(canvas);
  const sandbox = {
    window: {
      CanvasRenderingContext2D: StubCtx,
      HTMLCanvasElement: StubCanvasElement,
    },
    document: { querySelector: (selector) => (selector === "#timelineChart" ? canvas : null) },
  };
  return { sandbox, canvas, ctx };
}

test("M3.2：观察器按帧读取当前画面——旧帧绘制与测量器注入记录都不得进入本轮", () => {
  const { sandbox, canvas, ctx } = createFrameObserverStubDom();
  assert.equal(runInNewContext(buildColorObserverSource(), sandbox), "installed");

  ctx.fillText("旧轴标", 10, 20);
  ctx.clearRect(0, 0, 960, 320);
  ctx.fillText("当前轴标", 30, 40);
  const before = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), sandbox);
  assert.equal(before.frame, 1);
  assert.deepEqual(
    hostValue(before.records.map((record) => record.text)),
    ["当前轴标"],
    "清空画布后的旧帧记录必须被排除",
  );

  // 测量器自己重建底色层：标 injected，且不得推高应用侧帧号
  const observer = sandbox.window.__skinPaletteColorObserver;
  observer.beginInject();
  ctx.fillRect(0, 0, 960, 320);
  observer.endInject();
  const during = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), sandbox);
  assert.deepEqual(
    hostValue(during.records.map((record) => record.text)),
    ["当前轴标"],
    "注入记录必须被排除，且不得把帧号推高",
  );

  // 应用重置画布尺寸并重绘：只有新帧的记录是当前画面
  canvas.width = 480;
  canvas.height = 160;
  ctx.fillText("重置后轴标", 5, 6);
  const after = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), sandbox);
  assert.equal(
    after.frame,
    3,
    "尺寸重置记帧边界（width、height 各记一次：0 → clearRect → 1 → width → 2 → height → 3）",
  );
  assert.deepEqual(hostValue(after.records.map((record) => record.text)), ["重置后轴标"], "旧轴标不得进入新一轮测量");
});

test("M3.2：清空／尺寸重置后不重绘——当前帧零条记录，不得拿旧帧绘制充数", () => {
  // 回归：帧号取自"记录里的最大帧号"时，清空画布或重置尺寸后没有新绘制的画布仍
  // 会选中旧记录——一片空白的画布也能按旧轴文字"测"出比值并判通过。
  const clearedDraw = createFrameObserverStubDom();
  assert.equal(runInNewContext(buildColorObserverSource(), clearedDraw.sandbox), "installed");
  clearedDraw.ctx.fillText("旧轴标", 10, 20);
  clearedDraw.ctx.clearRect(0, 0, 960, 320);
  const afterClear = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), clearedDraw.sandbox);
  assert.equal(afterClear.ok, true);
  assert.equal(afterClear.frame, 1, "clearRect 记帧边界，当前帧号前进");
  assert.deepEqual(hostValue(afterClear.records), [], "清空后没有新绘制：不得再返回旧帧的绘制记录");

  const resetSize = createFrameObserverStubDom();
  assert.equal(runInNewContext(buildColorObserverSource(), resetSize.sandbox), "installed");
  resetSize.ctx.fillText("旧轴标", 10, 20);
  resetSize.canvas.width = 480;
  const afterReset = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), resetSize.sandbox);
  assert.equal(afterReset.ok, true);
  assert.equal(afterReset.frame, 1, "尺寸重置记帧边界，当前帧号前进");
  assert.deepEqual(hostValue(afterReset.records), [], "重置尺寸后没有新绘制：不得再返回旧帧的绘制记录");
});

test("M3.2：观察失败的绘制留下画布与帧号——读取侧把它算成缺测，不从覆盖率里蒸发", () => {
  // 现场：观察器读 fillStyle / measureText 时抛错，这条绘制连颜色坐标都没留下。
  // 静默丢掉它，就等于把一条没测到的绘制从覆盖率里抹掉。
  const dom = createFrameObserverStubDom();
  assert.equal(runInNewContext(buildColorObserverSource(), dom.sandbox), "installed");
  dom.ctx.measureText = () => {
    throw new Error("度量失败");
  };
  dom.ctx.fillText("坏文字", 7, 8);
  const stash = runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), dom.sandbox);
  assert.equal(stash.ok, true);
  const records = hostValue(stash.records);
  assert.equal(records.length, 1, "观察失败的记录必须留下来");
  assert.equal(records[0].method, "fillText");
  assert.match(records[0].observationError, /度量失败/);
  assert.equal(records[0].frame, 0, "失败记录也带帧号，才能按当前帧取舍");
  // 读取侧按 canvasRef 过滤后才返回（返回前再剥掉 canvasRef，画布对象不过界）：
  // 这条失败记录能出现在结果里，本身就证明它归属的是这块画布
  assert.equal(records.length, 1, "失败记录按画布归属过滤后必须仍在");
});

test("M3.2：滚动会话登记所有可滚动容器（含测量前停在 0 的）并核验恢复结果", () => {
  const dom = createElementStubDom();
  // 测量前 scrollTop=0、恢复后却停在 571 的容器（用户复现的原型）
  const zero = dom.build({
    selector: ".scroller-zero",
    rect: { x: 0, y: 0, width: 200, height: 100 },
    inline: { "overflow-y": "auto" },
  });
  Object.assign(zero, {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 300,
    scrollWidth: 200,
    clientHeight: 100,
    clientWidth: 200,
  });
  // 测量前已有偏移的容器
  const moved = dom.build({
    selector: ".scroller-moved",
    rect: { x: 0, y: 200, width: 200, height: 100 },
    inline: { "overflow-y": "auto" },
  });
  Object.assign(moved, {
    scrollTop: 571,
    scrollLeft: 0,
    scrollHeight: 900,
    scrollWidth: 200,
    clientHeight: 100,
    clientWidth: 200,
  });
  // 非滚动盒（overflow:visible）：scrollIntoView 不会移动它，不需要登记
  const plain = dom.build({
    selector: ".plain",
    rect: { x: 0, y: 400, width: 200, height: 100 },
  });
  Object.assign(plain, {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 500,
    scrollWidth: 200,
    clientHeight: 100,
    clientWidth: 200,
  });

  const begin = runInNewContext(buildProbeSource("scroll-begin"), dom.sandbox);
  assert.equal(begin.ok, true);
  assert.equal(begin.registeredContainers, 2, "按可滚动余量登记，与当前偏移无关");

  // 模拟 scrollIntoView 把两个容器都带走了
  zero.scrollTop = 571;
  moved.scrollTop = 0;
  const restore = runInNewContext(buildProbeSource("scroll-restore"), dom.sandbox);
  assert.equal(restore.ok, true);
  assert.equal(restore.restored, true, "逐个核验通过");
  assert.deepEqual(hostValue(restore.mismatches), []);
  assert.equal(zero.scrollTop, 0, "测量前停在 0 的容器必须回到 0");
  assert.equal(moved.scrollTop, 571, "已有偏移的容器必须回到原偏移");
});

test("M3.2：滚动恢复核验到不一致必须报出来，不静默返回 ok", () => {
  const dom = createElementStubDom();
  // 拒绝被写入的容器：恢复后仍与暂存值不一致，必须记进 mismatches
  const stubborn = dom.build({
    selector: ".stubborn",
    rect: { x: 0, y: 0, width: 200, height: 100 },
    inline: { "overflow-y": "auto" },
  });
  let reads = 0;
  Object.defineProperty(stubborn, "scrollTop", {
    get() {
      reads += 1;
      return reads === 1 ? 0 : 5;
    },
    set() {},
    configurable: true,
  });
  Object.assign(stubborn, { scrollLeft: 0, scrollHeight: 300, scrollWidth: 200, clientHeight: 100, clientWidth: 200 });

  const begin = runInNewContext(buildProbeSource("scroll-begin"), dom.sandbox);
  assert.equal(begin.registeredContainers, 1);
  const restore = runInNewContext(buildProbeSource("scroll-restore"), dom.sandbox);
  assert.equal(restore.ok, true);
  assert.equal(restore.restored, false);
  assert.equal(hostValue(restore.mismatches).length, 1, "未还原的容器必须逐条列出");
  assert.match(hostValue(restore.mismatches)[0], /容器滚动未还原/);
});

// --- B. 编排单测（脚本化假 page） ---------------------------------------------

const probeNode = (index, overrides = {}) => ({
  index,
  identityId: index + 1,
  text: `node-${index}`,
  tag: "div",
  id: `node-${index}`,
  className: "measurement-node",
  hostType: null,
  inputType: null,
  rect: { x: 100, y: 50, width: 200, height: 20 },
  client: { left: 0, top: 0, width: 200, height: 20 },
  textRects: [{ x: 100, y: 50, width: 200, height: 20 }],
  usesPlaceholder: false,
  isSvg: false,
  computed: {
    color: "rgb(0, 0, 0)",
    fontSize: "14px",
    fontWeight: "400",
    opacity: "1",
    textShadow: "none",
    textFillColor: "",
    visibility: "visible",
    display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
  },
  pseudo: null,
  chain: [{ tag: "div", opacity: "1", filter: "none", mixBlendMode: "normal", backdropFilter: "none" }],
  scroll: { x: 0, y: 0 },
  dpr: 1,
  ...overrides,
});

const inputProbeNode = (index, id, inputType, { hasValue, hasPlaceholder, color = "rgb(0, 0, 0)" } = {}) =>
  probeNode(index, {
    tag: "input",
    id,
    className: "search-control",
    hostType: "input",
    inputType,
    hasValue,
    hasPlaceholder,
    usesPlaceholder: hasPlaceholder && !hasValue,
    computed: { ...probeNode(index).computed, color },
    pseudo: { color: "rgb(0, 0, 0)", opacity: "0.76", fontSize: "13px", textFillColor: "" },
  });

const afterSnapshot = (node) => ({
  color: node.computed.color,
  textFillColor: node.computed.textFillColor,
  textShadow: node.computed.textShadow,
  backgroundColor: node.computed.backgroundColor,
  opacity: node.computed.opacity,
  rect: node.rect,
});

const pixels = (rgba, count) => new Array(count * 4).fill(0).flatMap(() => rgba);

/** 浮点断言：坐标换算涉及尺寸比，逐位相等没有意义（浏览器与 Node 同为 IEEE754）。 */
const closeTo = (actual, expected, tolerance = 1e-9) =>
  typeof actual === "number" && Math.abs(actual - expected) <= tolerance;

const scanResult = (entries) => ({
  width: 220,
  height: 24,
  scale: { x: 1, y: 1 },
  regions: entries.map(([id, rgba]) => ({ id, columns: 2, rows: 1, origin: { x: 0, y: 0 }, pixels: pixels(rgba, 2) })),
});

function simulatedOcclusion(
  source,
  { scroll = { x: 0, y: 0 }, blocked = null, descendantPoint = null, pointCount = 5 } = {},
) {
  const rectsMatch = /const rects = (.*);/.exec(source);
  const indexMatch = /const index = (.*);/.exec(source);
  const rects = rectsMatch ? JSON.parse(rectsMatch[1]) : [];
  const index = indexMatch ? JSON.parse(indexMatch[1]) : 0;
  const kinds = ["center", "topLeft", "topRight", "bottomLeft", "bottomRight"];
  return {
    identityValid: true,
    scroll,
    rects: rects.map((rect, rectIndex) => {
      const inset = Math.min(2, rect.width / 4, rect.height / 4);
      const coordinates = [
        [rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.x + inset, rect.y + inset],
        [rect.x + rect.width - inset, rect.y + inset],
        [rect.x + inset, rect.y + rect.height - inset],
        [rect.x + rect.width - inset, rect.y + rect.height - inset],
      ];
      return {
        rectIndex,
        points: kinds.slice(0, pointCount).map((kind, pointIndex) => {
          const isBlocked = blocked?.rectIndex === rectIndex && blocked.pointIndex === pointIndex;
          const isDescendant = descendantPoint?.rectIndex === rectIndex && descendantPoint.pointIndex === pointIndex;
          return {
            kind,
            x: coordinates[pointIndex][0],
            y: coordinates[pointIndex][1],
            top: isBlocked
              ? {
                  identityId: 90,
                  tag: "div",
                  id: "modal-overlay",
                  className: "overlay",
                  hostType: null,
                  inputType: null,
                }
              : isDescendant
                ? {
                    identityId: index + 10,
                    tag: "span",
                    id: `node-${index}-label`,
                    className: "label",
                    hostType: null,
                    inputType: null,
                  }
                : {
                    identityId: index + 1,
                    tag: "div",
                    id: `node-${index}`,
                    className: "measurement-node",
                    hostType: null,
                    inputType: null,
                  },
            withinHost: !isBlocked,
          };
        }),
      };
    }),
  };
}

/** 脚本化假 page：按 skinProbe 标记分派到 canned 处理器；记录 evaluate/screenshot 调用。 */
function createScriptedPage(handlers) {
  const evaluations = [];
  const screenshots = [];
  const fullPageFixture = createStableFullPageNodePage();
  return {
    evaluations,
    screenshots,
    fullPageFixture,
    initScripts: [],
    async evaluate(source, argument) {
      if (typeof source === "function") return fullPageFixture.page.evaluate(source, argument);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      if (!tag) throw new TypeError("页内源缺少 skinProbe 标记");
      const handler = handlers[tag];
      if (typeof handler !== "function") throw new TypeError(`脚本化 page 未提供 ${tag} 的处理`);
      evaluations.push(tag);
      return handler(source);
    },
    async screenshot(options) {
      screenshots.push(options);
      if (options?.fullPage === true) return fullPageFixture.page.screenshot(options);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
    async addInitScript(script) {
      this.initScripts.push(script);
    },
  };
}

const defaultHandlers = (overrides = {}) => {
  const nodes = [probeNode(0), probeNode(1)];
  // 真实浏览器对非法选择器抛 SyntaxError；目录里少数"选择器"实为中文描述
  const validSelector = (selector) => !selector.includes("::") && !/[一-龥]/.test(selector);
  return {
    viewport: () => ({ width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 }),
    "node-probe": (source) => {
      const embedded = /const selector = ("(?:[^"\\]|\\.)*")/.exec(source)?.[1];
      const selector = embedded ? JSON.parse(embedded) : "";
      if (!validSelector(selector)) return { error: `选择器无法解析：${selector}` };
      return { nodes };
    },
    "occlusion-probe": (source) => simulatedOcclusion(source),
    "color-parse": () => ({ ok: true, rgb: [1, 1, 1], alpha: 1, readBack: "#ffffff" }),
    hide: () => ({ ok: true, originals: { "-webkit-text-fill-color": "", "text-shadow": "none" } }),
    restore: () => ({ ok: true }),
    verify: () => ({ ok: true, after: afterSnapshot(nodes[0]) }),
    scan: () =>
      scanResult([
        ["text-0-0", [0, 0, 0, 255]],
        ["text-1-0", [128, 128, 128, 255]],
      ]),
    "compare-images": () => ({
      identical: true,
      width: 1200,
      height: 2100,
      differingPixels: 0,
      maxChannelDelta: 0,
      bbox: null,
    }),
    "spotlight-stability": () => ({
      stable: true,
      reason: null,
      budgetMs: 500,
      waitedMs: 0,
      frameCount: 4,
      transitionsWaited: 0,
      initial: [],
      settled: [],
    }),
    "scroll-begin": () => ({ ok: true, alreadyActive: false, movedContainers: 0 }),
    "scroll-restore": () => ({ ok: true, restored: true }),
    "release-attempt": () => ({ ok: true, restoredTargets: 0, releasedSessions: 0, attemptReleased: true }),
    "bring-into-view": () => ({ ok: true, scrolled: false, scroll: { x: 0, y: 0 } }),
    "scroll-by": () => ({ x: 0, y: 0 }),
    "scroll-to": () => ({ x: 0, y: 0 }),
    "canvas-stash": () => ({
      ok: true,
      selector: "#timelineChart",
      canvasId: "timelineChart",
      frame: 0,
      bitmap: { width: 960, height: 320 },
      cssRect: { x: 40, y: 300, width: 400, height: 120 },
      scroll: { x: 0, y: 0 },
      dpr: 1,
      records: [
        {
          method: "fillText",
          fillStyle: "#ffffff",
          alpha: 1,
          composite: "source-over",
          font: "12px sans-serif",
          textAlign: "right",
          transform: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 },
          text: "L1",
          x: 100,
          y: 50,
          rectArgs: null,
          measured: { width: 20, ascent: 9, descent: 3 },
        },
        {
          method: "fillRect",
          fillStyle: "#f0f0f0",
          alpha: 1,
          composite: "source-over",
          transform: null,
          rectArgs: [0, 0, 960, 320],
          text: null,
          x: null,
          y: null,
          measured: null,
        },
        {
          method: "fillText",
          fillStyle: "#101010",
          alpha: 1,
          composite: "multiply",
          font: "12px sans-serif",
          textAlign: "left",
          transform: null,
          text: "x",
          x: 3,
          y: 4,
          rectArgs: null,
          measured: { width: 8, ascent: 9, descent: 3 },
        },
      ],
    }),
    "canvas-clear": () => ({ ok: true, rebuiltBaseLayers: 1 }),
    "canvas-restore": () => ({ ok: true, identical: true, differingPixels: 0 }),
    ...overrides,
  };
};

const createInputRoleMeasurementPage = (nodesBySelector) => {
  const selectors = [];
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": (source) => {
        const match = /const selector = ("(?:[^"\\]|\\.)*");/.exec(source);
        const selector = match ? JSON.parse(match[1]) : "";
        selectors.push(selector);
        return { nodes: nodesBySelector[selector] ?? [] };
      },
    }),
  );
  return { page, selectors };
};

const measureTextFixture = (page) =>
  measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });

test("M5.2.C-E1b：输入角色按状态消费自己的 selector，不回退全局 selector", async () => {
  const routes = [
    [
      "input.placeholder",
      "dashboard-default",
      ":is(#modelComparisonSearch, #repositoryComparisonSearch)",
      ":is(#modelComparisonSearch, #repositoryComparisonSearch)::placeholder",
    ],
    ["input.placeholder", "dialog-pricing-open", "#pricingSearch", "#pricingSearch::placeholder"],
    ["input.placeholder", "input-focus", "#pricingSearch", "#pricingSearch::placeholder"],
    ["input.value", "pricing-input-filled", "#pricingSearch, #usdToCnyRate", "#pricingSearch, #usdToCnyRate"],
    ["input.value", "dialog-import-open", "#importPath", "#importPath"],
  ];
  for (const [roleId, stateId, expectedProbeSelector, expectedRoleSelector] of routes) {
    const harness = createInputRoleMeasurementPage({});
    const result = await measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId,
      roleCatalog: [m32Role(roleId)],
      policy: M31_POLICY,
    });
    assert.equal(result.records[0].result, "unmeasured", `${roleId}/${stateId} 零目标仍须缺测`);
    assert.deepEqual([...new Set(harness.selectors)], [expectedProbeSelector]);
    assert.equal(JSON.parse(result.records[0].evidence).selector, expectedRoleSelector);
  }

  const missingMapRole = m32Role("input.placeholder", {
    selectorsByState: { "input-focus": "#pricingSearch::placeholder" },
  });
  const missingMap = createInputRoleMeasurementPage({});
  const missingResult = await measureBrowserRoles({
    page: missingMap.page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [missingMapRole],
    policy: M31_POLICY,
  });
  assert.equal(missingResult.records[0].result, "unmeasured");
  assert.match(missingResult.records[0].reason, /input\.placeholder.*dashboard-default.*未登记.*拒绝回退/);
  assert.equal(JSON.parse(missingResult.records[0].evidence).selector, null);
  assert.deepEqual(missingMap.selectors, [], "缺状态映射时不能查询旧全局 selector");

  const invalidMapRole = m32Role("input.placeholder", { selectorsByState: { "dashboard-default": " " } });
  const invalidMap = createInputRoleMeasurementPage({});
  const invalidResult = await measureBrowserRoles({
    page: invalidMap.page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [invalidMapRole],
    policy: M31_POLICY,
  });
  assert.equal(invalidResult.records[0].result, "unmeasured");
  assert.match(invalidResult.records[0].reason, /input\.placeholder.*dashboard-default.*selector.*非法/);
  assert.deepEqual(invalidMap.selectors, [], "非法状态 selector 不能进入查询");

  const inheritedMapRole = m32Role("input.placeholder", {
    selectorsByState: Object.create({ "input-focus": "#inherited::placeholder" }),
  });
  const inheritedMap = createInputRoleMeasurementPage({});
  const inheritedResult = await measureBrowserRoles({
    page: inheritedMap.page,
    candidate: null,
    mode: "light",
    stateId: "input-focus",
    roleCatalog: [inheritedMapRole],
    policy: M31_POLICY,
  });
  assert.equal(inheritedResult.records[0].result, "unmeasured");
  assert.deepEqual(inheritedMap.selectors, [], "继承属性不算自有 selector 映射");
});

test("D7：button.secondary 只测活动弹窗次按钮，缺状态映射不得回退", async () => {
  const role = m32Role("button.secondary");
  const stateId = "dialog-import-open";
  const selector = role.selectorsByState[stateId];
  const dom = createElementStubDom();
  const targetIds = ["cancelImportButton", "pickImportDirectoryButton"];
  const targets = targetIds.map((id, index) =>
    dom.build({
      selector,
      id,
      tag: "BUTTON",
      text: id,
      rect: { x: 12 + index * 90, y: 20, width: 72, height: 18 },
      computed: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
    }),
  );
  dom.setHitTest((x, y) =>
    targets.find(
      ({ _rect: rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
    ),
  );
  dom.build({
    selector: role.selector,
    id: "backgroundGlobalButton",
    tag: "BUTTON",
    text: "后台按钮",
    rect: { x: 210, y: 20, width: 72, height: 18 },
    computed: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
  });
  const queriedSelectors = [];
  const querySelectorAll = dom.sandbox.document.querySelectorAll;
  dom.sandbox.document.querySelectorAll = (query) => {
    queriedSelectors.push(query);
    return querySelectorAll(query);
  };
  const { page } = createActualSurfacePage(dom, {
    pixels: d8f2PixelGrid([255, 255, 255], [255, 255, 255]),
  });
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId,
    roleCatalog: [role],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "pass", record.reason);
  assert.equal(evidence.selector, selector);
  assert.deepEqual(
    evidence.nodes.map((node) => node.identity.id),
    targetIds,
    "only the cancel and directory-picker controls in the open import dialog are measured",
  );
  assert.ok(queriedSelectors.includes(selector));
  assert.equal(queriedSelectors.includes(role.selector), false, "the global selector must not be queried");

  const missingMapRole = { ...role, selectorsByState: { ...role.selectorsByState } };
  delete missingMapRole.selectorsByState[stateId];
  queriedSelectors.length = 0;
  const missingMap = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId,
    roleCatalog: [missingMapRole],
    policy: M31_POLICY,
  });
  const missingRecord = missingMap.records[0];
  const missingEvidence = JSON.parse(missingRecord.evidence);
  assert.equal(missingRecord.result, "unmeasured");
  assert.match(missingRecord.reason, /button\.secondary.*dialog-import-open.*未登记.*拒绝回退/);
  assert.equal(missingEvidence.selector, null);
  assert.equal(missingEvidence.selectorStateId, stateId);
  assert.equal(queriedSelectors.includes(selector), false);
  assert.equal(queriedSelectors.includes(role.selector), false);
});

test("M5.2.C-E1b：输入值与 placeholder 的节点级 not-applicable 不污染活动目标", async () => {
  const valueSelector = "#pricingSearch, #usdToCnyRate";
  const valueHarness = createInputRoleMeasurementPage({
    [valueSelector]: [
      inputProbeNode(0, "pricingSearch", "search", { hasValue: true, hasPlaceholder: true }),
      inputProbeNode(1, "usdToCnyRate", "number", { hasValue: false, hasPlaceholder: false }),
    ],
  });
  let valueCdpSessions = 0;
  valueHarness.page.context = () => ({
    newCDPSession: async () => {
      valueCdpSessions += 1;
      throw new Error("input.value 不得创建 placeholder 原生 CDP 会话");
    },
  });
  const valueResult = await measureBrowserRoles({
    page: valueHarness.page,
    candidate: null,
    mode: "light",
    stateId: "pricing-input-filled",
    roleCatalog: [m32Role("input.value")],
    policy: M31_POLICY,
  });
  const valueRecord = valueResult.records[0];
  const valueEvidence = JSON.parse(valueRecord.evidence);
  assert.equal(valueRecord.result, "pass");
  assert.equal(valueEvidence.measuredCount, 1);
  assert.equal(valueEvidence.notApplicableCount, 1);
  assert.equal(valueEvidence.unmeasuredCount, 0);
  assert.equal(valueEvidence.notApplicableNodes[0].identity.id, "usdToCnyRate");
  assert.match(valueEvidence.notApplicableNodes[0].reason, /值为空/);
  assert.ok(
    valueHarness.selectors.every((selector) => selector === valueSelector),
    "重探和取样持续使用同一状态 selector",
  );
  assert.equal(valueCdpSessions, 0, "input.value 不进入原生 placeholder CDP 路径");

  const placeholderHarness = createInputPlaceholderMeasurementPage({
    nodes: [
      nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 50 }),
      inputProbeNode(1, "repositoryComparisonSearch", "search", { hasValue: true, hasPlaceholder: true }),
      inputProbeNode(2, "repositoryComparisonSearch-alt", "search", { hasValue: false, hasPlaceholder: false }),
    ],
  });
  const placeholderResult = await measureBrowserRoles({
    page: placeholderHarness.page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("input.placeholder")],
    policy: M31_POLICY,
  });
  const placeholderRecord = placeholderResult.records[0];
  const placeholderEvidence = JSON.parse(placeholderRecord.evidence);
  assert.equal(placeholderRecord.result, "pass");
  assert.equal(placeholderEvidence.measuredCount, 1);
  assert.equal(placeholderEvidence.notApplicableCount, 2);
  assert.equal(placeholderEvidence.unmeasuredCount, 0);
  assert.deepEqual(
    placeholderEvidence.notApplicableNodes.map((node) => [node.identity.id, node.reason]),
    [
      ["repositoryComparisonSearch", "输入已有值，当前显示正文而非 placeholder"],
      ["repositoryComparisonSearch-alt", "输入控件没有 placeholder"],
    ],
  );

  for (const [roleId, stateId, selector, node] of [
    [
      "input.value",
      "pricing-input-filled",
      valueSelector,
      inputProbeNode(0, "pricingSearch", "search", { hasValue: false, hasPlaceholder: true }),
    ],
    [
      "input.placeholder",
      "dialog-pricing-open",
      "#pricingSearch",
      inputProbeNode(0, "pricingSearch", "search", { hasValue: false, hasPlaceholder: false }),
    ],
  ]) {
    const allNotApplicable = createInputRoleMeasurementPage({ [selector]: [node] });
    const result = await measureBrowserRoles({
      page: allNotApplicable.page,
      candidate: null,
      mode: "light",
      stateId,
      roleCatalog: [m32Role(roleId)],
      policy: M31_POLICY,
    });
    const record = result.records[0];
    const evidence = JSON.parse(record.evidence);
    assert.equal(record.result, "unmeasured", "必要角色全不适用仍不得整角色豁免");
    assert.equal(record.ratio, null);
    assert.equal(evidence.measuredCount, 0);
    assert.equal(evidence.unmeasuredCount, 0);
    assert.equal(evidence.notApplicableCount, 1);
    assert.equal(evidence.notApplicableNodes[0].identity.id, "pricingSearch");
  }
});

test("M5.2.C-E1b：活动目标的颜色/类型缺测保留节点身份，checkbox 不伪装成文字", async () => {
  const selector = "#pricingSearch, #usdToCnyRate";
  const colorMissing = createInputRoleMeasurementPage({
    [selector]: [inputProbeNode(0, "pricingSearch", "search", { hasValue: true, hasPlaceholder: true, color: null })],
  });
  const colorResult = await measureBrowserRoles({
    page: colorMissing.page,
    candidate: null,
    mode: "light",
    stateId: "pricing-input-filled",
    roleCatalog: [m32Role("input.value")],
    policy: M31_POLICY,
  });
  const colorRecord = colorResult.records[0];
  const colorEvidence = JSON.parse(colorRecord.evidence);
  assert.equal(colorRecord.result, "unmeasured");
  assert.match(colorRecord.reason, /读取不到文字颜色/);
  assert.equal(colorEvidence.unmeasuredCount, 1);
  assert.equal(colorEvidence.unmeasuredNodes[0].index, 0);
  assert.equal(colorEvidence.unmeasuredNodes[0].identity.id, "pricingSearch");

  const opacityNode = inputProbeNode(0, "pricingSearch", "search", { hasValue: true, hasPlaceholder: true });
  opacityNode.computed = { ...opacityNode.computed, opacity: "0.5" };
  opacityNode.chain = [
    { tag: "input", opacity: "0.5", filter: "none", mixBlendMode: "normal", backdropFilter: "none" },
  ];
  const opacityHarness = createInputRoleMeasurementPage({ [selector]: [opacityNode] });
  const opacityResult = await measureBrowserRoles({
    page: opacityHarness.page,
    candidate: null,
    mode: "light",
    stateId: "pricing-input-filled",
    roleCatalog: [m32Role("input.value")],
    policy: M31_POLICY,
  });
  const opacityRecord = opacityResult.records[0];
  const opacityEvidence = JSON.parse(opacityRecord.evidence);
  assert.equal(opacityRecord.result, "unmeasured");
  assert.match(opacityRecord.reason, /opacity/);
  assert.equal(opacityEvidence.unmeasuredNodes[0].identity.id, "pricingSearch");
  assert.equal(opacityHarness.selectors.length, 2, "captureOriginal 也用状态 selector 取目标原图");
  assert.ok(opacityHarness.selectors.every((probeSelector) => probeSelector === selector));
  assert.equal(opacityHarness.page.screenshots.filter((screenshot) => screenshot?.clip).length, 1);

  const checkbox = createInputRoleMeasurementPage({
    [selector]: [inputProbeNode(0, "pricingSearch", "checkbox", { hasValue: true, hasPlaceholder: false })],
  });
  const checkboxResult = await measureBrowserRoles({
    page: checkbox.page,
    candidate: null,
    mode: "light",
    stateId: "pricing-input-filled",
    roleCatalog: [m32Role("input.value")],
    policy: M31_POLICY,
  });
  const checkboxRecord = checkboxResult.records[0];
  const checkboxEvidence = JSON.parse(checkboxRecord.evidence);
  assert.equal(checkboxRecord.result, "unmeasured");
  assert.match(checkboxRecord.reason, /目标类型违约/);
  assert.equal(checkboxEvidence.unmeasuredNodes[0].identity.inputType, "checkbox");
  assert.equal(checkbox.page.evaluations.includes("scan"), false);
});

test("M3.2：浏览器不可用——全部预期角色记 unmeasured（ENVIRONMENT_BLOCKED），不伪造通过", async () => {
  const roles = ROLE_CATALOG.filter((role) => role.states.includes("dashboard-default"));
  const blockedPages = [
    null,
    undefined,
    { evaluate: async () => ({}) },
    { evaluate: async () => ({}), screenshot: "not-a-function" },
  ];
  for (const page of blockedPages) {
    const result = await measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: roles,
      policy: M31_POLICY,
    });
    assert.equal(result.records.length, roles.length);
    assert.ok(
      result.records.every((record) => record.result === "unmeasured"),
      "缺失环境不得记为通过",
    );
    assert.ok(result.records.every((record) => record.reason.includes("ENVIRONMENT_BLOCKED")));
    assert.equal(result.diagnostics.environmentBlocked, true);
    assert.equal(result.captures.length, 0);
    assert.ok(result.diagnostics.blockedReason.length > 0);
    assert.equal(result.diagnostics.counts.unmeasured, roles.length);
    assert.equal(
      result.records.filter((record) => record.threshold !== null).length,
      roles.filter((role) => role.threshold !== null).length,
      "缺测角色仍保留目录阈值（M3.4 据此区分缺测与无阈值）",
    );
    for (const record of result.records) {
      assert.deepEqual(Object.keys(record).sort(), M32_RECORD_FIELDS, "记录恰好十字段，无扩展字段");
    }
  }
});

test("M3.2：文字路径多节点汇总最差样本——同一角色取最低比值并附证据与截图索引", async () => {
  const page = createScriptedPage(defaultHandlers());
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.roleId, "page.body-text");
  assert.equal(record.method, "browser-text-pixels");
  assert.equal(record.result, "fail", "最差样本低于阈值必须判败（不取平均、不取最好）");
  const expected = contrastRatio([1, 1, 1], [128 / 255, 128 / 255, 128 / 255]);
  assert.equal(record.ratio, expected, "比值用共享 color-math 完整精度计算");
  assert.ok(record.ratio < 4.5);
  assert.match(record.reason, /最差样本.*阈值/);
  assert.deepEqual(Object.keys(record).sort(), M32_RECORD_FIELDS);
  assert.equal(record.candidateId, "official-source");

  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.kind, "browser-text-pixels");
  assert.equal(evidence.nodes.length, 2, "多个匹配节点逐一测");
  assert.equal(evidence.worst.node, 1, "汇总的是最差节点");
  assert.equal(evidence.nodes[0].bands.length, 1, "目标整个落入视口：一个测量带");
  assert.equal(evidence.nodes[0].bands[0].capture, 0);
  assert.equal(evidence.nodes[1].bands[0].capture, 1);
  assert.deepEqual(evidence.nodes[0].bands[0].clip, { x: 100, y: 50, width: 200, height: 20 });
  assert.deepEqual(evidence.nodes[0].bands[0].scanScale, { x: 1, y: 1 }, "截图 scale 写进证据");
  assert.equal(evidence.nodes[0].bands[0].worst.ratio, contrastRatio([1, 1, 1], [0, 0, 0]));
  assert.equal(evidence.nodes[0].textRects, 1);
  assert.deepEqual(evidence.nodes[0].identity, {
    identityId: 1,
    tag: "div",
    id: "node-0",
    className: "measurement-node",
    hostType: null,
    inputType: null,
  });
  assert.deepEqual(evidence.nodes[0].style, {
    opacity: "1",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
  });
  assert.deepEqual(evidence.nodes[0].geometry, {
    rect: { x: 100, y: 50, width: 200, height: 20 },
    client: { left: 0, top: 0, width: 200, height: 20 },
    textRects: [{ x: 100, y: 50, width: 200, height: 20 }],
  });
  assert.equal(evidence.nodes[0].bands[0].occlusion.rects[0].points.length, 5, "采样矩形具备完整五点结果");

  assert.equal(result.captures.length, 2, "每个节点的背景截图各自留存");
  for (const capture of result.captures) {
    assert.equal(capture.kind, "background");
    assert.equal(capture.roleId, "page.body-text");
    assert.equal(capture.dpr, 1);
    assert.ok(capture.pngBase64.length > 0);
    assert.deepEqual(Object.keys(capture.clip), ["x", "y", "width", "height"]);
  }
  assert.equal(result.diagnostics.restoration.styleDifferences.length, 0);
  assert.equal(result.diagnostics.restoration.rectDifferences.length, 0);
  assert.equal(result.diagnostics.restoration.statePixelDiff.identical, true, "整页截图前后无像素差异");
  assert.equal(result.diagnostics.counts.fail, 1);
  // 编排顺序：先视口基准，再逐角色，最后整页复核
  assert.equal(page.evaluations[0], "viewport");
  assert.equal(page.evaluations.at(-1), "compare-images");
});

test("M5.2.C-D2a：每个实际滚动 band 都调用当时的遮挡探针并落盘", async () => {
  let scrollSteps = 0;
  const probeCalls = [];
  const page = createScriptedPage(
    defaultHandlers({
      viewport: () => ({ width: 100, height: 100, scrollX: 0, scrollY: 0, dpr: 1 }),
      "node-probe": () => ({
        nodes: [
          probeNode(0, {
            rect: { x: 10, y: 10, width: 30, height: scrollSteps === 0 ? 250 : 80 },
            textRects: [{ x: 12, y: 12, width: 20, height: 10 }],
            pseudo: {
              color: "rgb(20, 30, 40)",
              opacity: "0.7",
              fontSize: "12px",
              textFillColor: "",
              content: "PRIVATE_PSEUDO_TEXT",
            },
            scroll: { x: 0, y: scrollSteps * 52 },
          }),
        ],
        attemptToken: "attempt-bands",
      }),
      "scroll-by": () => {
        scrollSteps += 1;
        return { x: 0, y: scrollSteps * 52 };
      },
      "occlusion-probe": (source) => {
        const scroll = { x: 0, y: scrollSteps * 52 };
        const rects = JSON.parse(/const rects = (.*);/.exec(source)[1]);
        probeCalls.push({ scroll, rects });
        return simulatedOcclusion(source, { scroll });
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const evidence = JSON.parse(result.records[0].evidence);
  const bands = evidence.nodes[0].bands;
  assert.equal(bands.length, 2, "测试覆盖两个真实迭代到的滚动带");
  assert.deepEqual(
    probeCalls.map((call) => call.scroll.y),
    [0, 52],
  );
  assert.deepEqual(
    bands.map((band) => band.occlusion.scroll.y),
    [0, 52],
  );
  assert.deepEqual(
    bands.map((band) => band.occlusion.rects[0].rectIndex),
    [0, 0],
  );
  assert.ok(bands.every((band) => band.occlusion.rects[0].points.length === 5));
  assert.deepEqual(
    bands.map((band) => band.sampleRects[0].y),
    [12, 12],
  );
  assert.deepEqual(evidence.nodes[0].pseudo, {
    color: "rgb(20, 30, 40)",
    opacity: "0.7",
    fontSize: "12px",
    textFillColor: "",
  });
  assert.doesNotMatch(result.records[0].evidence, /PRIVATE_PSEUDO_TEXT/);
});

test("M5.2.C-D2b1：宿主或后代命中保留原来的数值测量", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes: [probeNode(0)], attemptToken: "attempt-descendant" }),
      "occlusion-probe": (source) => simulatedOcclusion(source, { descendantPoint: { rectIndex: 0, pointIndex: 0 } }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureTextFixture(page);
  assert.equal(result.records[0].result, "pass");
  assert.equal(result.records[0].ratio, contrastRatio([1, 1, 1], [0, 0, 0]));
  const evidence = JSON.parse(result.records[0].evidence);
  assert.equal(evidence.nodes[0].bands[0].occlusion.rects[0].points[0].top.tag, "span");
  assert.equal(evidence.nodes[0].bands[0].occlusion.rects[0].points[0].withinHost, true);
});

test("M5.2.C-D2b1：外部覆盖命中在截图和扫描前拒绝，并照常恢复样式与滚动", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes: [probeNode(0)], attemptToken: "attempt-covered" }),
      "occlusion-probe": (source) => simulatedOcclusion(source, { blocked: { rectIndex: 0, pointIndex: 2 } }),
    }),
  );
  const result = await measureTextFixture(page);
  const record = result.records[0];
  assert.equal(record.result, "unmeasured");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /identityId=1 div#node-0/);
  assert.match(record.reason, /topRight.*modal-overlay/);
  assert.equal(result.captures.length, 0, "被遮挡 band 不生成背景截图");
  assert.equal(page.screenshots.filter((shot) => shot.clip).length, 0, "只允许整体恢复核验截图");
  assert.equal(page.evaluations.includes("scan"), false, "遮挡样本不得进入像素扫描");
  assert.ok(page.evaluations.includes("restore"));
  assert.ok(page.evaluations.includes("verify"));
  assert.ok(page.evaluations.includes("scroll-restore"));
  assert.ok(page.evaluations.includes("release-attempt"));
  assert.deepEqual(result.diagnostics.restoration.styleDifferences, []);
  assert.deepEqual(result.diagnostics.restoration.scrollDifferences, []);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.nodes[0].identity.identityId, 1);
  assert.match(evidence.nodes[0].bands[0].rejected, /modal-overlay/);
  assert.equal(evidence.nodes[0].bands[0].occlusion.rects[0].points[2].top.id, "modal-overlay");
});

test("M5.2.C-D2b1：null、缺探针、错误或不完整形状一律作为缺测", async () => {
  const variants = [
    [
      "null result",
      (handlers) => {
        handlers["occlusion-probe"] = () => null;
      },
    ],
    [
      "missing probe",
      (handlers) => {
        delete handlers["occlusion-probe"];
      },
    ],
    [
      "probe error",
      (handlers) => {
        handlers["occlusion-probe"] = () => ({ identityValid: true, error: "probe failed", rects: [] });
      },
    ],
    [
      "missing rectangle",
      (handlers) => {
        handlers["occlusion-probe"] = () => ({ identityValid: true, scroll: { x: 0, y: 0 }, rects: [] });
      },
    ],
    [
      "four points",
      (handlers) => {
        handlers["occlusion-probe"] = (source) => simulatedOcclusion(source, { pointCount: 4 });
      },
    ],
  ];
  for (const [label, configure] of variants) {
    const handlers = defaultHandlers({
      "node-probe": () => ({ nodes: [probeNode(0)], attemptToken: `attempt-${label}` }),
    });
    configure(handlers);
    const page = createScriptedPage(handlers);
    const result = await measureTextFixture(page);
    assert.equal(result.records[0].result, "unmeasured", label);
    assert.equal(result.records[0].ratio, null, label);
    assert.match(result.records[0].reason, /identityId=1/, label);
    assert.equal(page.evaluations.includes("scan"), false, label);
    assert.equal(result.captures.length, 0, label);
  }
});

test("M5.2.C-D2b1：后续 band 遮挡会撤销本节点先前 band 的数值", async () => {
  let scrollSteps = 0;
  const page = createScriptedPage(
    defaultHandlers({
      viewport: () => ({ width: 100, height: 100, scrollX: 0, scrollY: 0, dpr: 1 }),
      "node-probe": () => ({
        nodes: [
          probeNode(0, {
            rect: { x: 10, y: 10, width: 30, height: scrollSteps === 0 ? 250 : 80 },
            textRects: [{ x: 12, y: 12, width: 20, height: 10 }],
            scroll: { x: 0, y: scrollSteps * 52 },
          }),
        ],
        attemptToken: "attempt-late-overlay",
      }),
      "scroll-by": () => {
        scrollSteps += 1;
        return { x: 0, y: scrollSteps * 52 };
      },
      "occlusion-probe": (source) =>
        simulatedOcclusion(source, {
          scroll: { x: 0, y: scrollSteps * 52 },
          blocked: scrollSteps === 1 ? { rectIndex: 0, pointIndex: 4 } : null,
        }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureTextFixture(page);
  const record = result.records[0];
  assert.equal(record.result, "unmeasured");
  assert.equal(record.ratio, null);
  assert.equal(result.captures.length, 1, "只截取遮挡前有效的第一带");
  assert.equal(page.evaluations.filter((tag) => tag === "scan").length, 1, "被遮挡的第二带不扫描");
  assert.ok(page.evaluations.includes("restore") && page.evaluations.includes("verify"));
  assert.ok(page.evaluations.includes("scroll-restore") && page.evaluations.includes("release-attempt"));
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 0);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.equal(evidence.nodes[0].bands.length, 2);
  assert.equal(Object.hasOwn(evidence.nodes[0].bands[0], "worst"), false, "已撤销 band 不再留下对比度值");
  assert.match(evidence.nodes[0].bands[1].rejected, /bottomRight.*modal-overlay/);
  assert.match(evidence.unmeasuredReasons[0], /撤销该节点此前 1 个 band/);
});

test("M5.2.C-D2b1：遮挡缺测与另一节点真实失败并存时仍保留 fail", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      "occlusion-probe": (source) => {
        const index = JSON.parse(/const index = (.*);/.exec(source)[1]);
        return simulatedOcclusion(source, { blocked: index === 0 ? { rectIndex: 0, pointIndex: 1 } : null });
      },
    }),
  );
  const result = await measureTextFixture(page);
  const record = result.records[0];
  assert.equal(record.result, "fail", "真实失败优先于同角色另一节点的遮挡缺测");
  assert.ok(record.ratio < record.threshold);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 1);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.match(evidence.unmeasuredReasons[0], /identityId=1.*topLeft.*modal-overlay/);
  assert.equal(evidence.unmeasuredNodes[0].index, 0);
  assert.equal(evidence.unmeasuredNodes[0].identity.id, "node-0");
  assert.equal(evidence.nodes.length, 2, "遮挡节点身份与未测原因仍留在总证据中");
  assert.equal(page.evaluations.filter((tag) => tag === "scan").length, 1);
});

test("M3.2：alpha 前景按实际 alpha 与每个背景样本合成后再算比值", async () => {
  const nodes = [probeNode(0)];
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes }),
      "color-parse": () => ({ ok: true, rgb: [1, 1, 1], alpha: 0.5, readBack: "rgba(255, 255, 255, 0.5)" }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  const expected = contrastRatio(compositeSrgb([1, 1, 1], 0.5, [0, 0, 0]), [0, 0, 0]);
  assert.equal(record.ratio, expected, "0.5 白叠黑底后取合成色比值（不是原色、不是背景色）");
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.worst.foreground.alpha, 0.5);
});

test("M5.2.P-A5：仅有生成探针证明的普通文字叶允许目标自身 opacity", async () => {
  const generateNode = ({
    parentOpacity = "1",
    text = "Metric label",
    descendants = [],
    pseudo = null,
    computed = {},
    rect,
  } = {}) => {
    const dom = createElementStubDom();
    const parent =
      parentOpacity === null
        ? null
        : dom.build({
            selector: "#parent",
            tag: "BODY",
            rect: { x: 90, y: 40, width: 220, height: 40 },
            computed: { opacity: parentOpacity },
          });
    dom.build({
      selector: "#target",
      tag: "SPAN",
      text,
      descendants,
      pseudo,
      parentElement: parent,
      rect: rect ?? { x: 100, y: 50, width: 200, height: 20 },
      clientWidth: rect?.width,
      clientHeight: rect?.height,
      computed: {
        opacity: "0.55",
        color: "rgba(255, 255, 255, 0.4)",
        ...computed,
      },
    });
    const probe = runInNewContext(
      buildProbeSource("node-probe", "#target", null, null, true, false, true),
      dom.sandbox,
    );
    assert.equal(probe.nodes.length, 1);
    return { node: hostValue(probe.nodes[0]), attemptToken: probe.attemptToken };
  };
  const measure = async (node, attemptToken = null) => {
    const page = createScriptedPage(
      defaultHandlers({
        "node-probe": () => ({ nodes: [node], attemptToken, measurementIdentity: { valid: true, reason: null } }),
        "color-parse": (source) => {
          const value = JSON.parse(/const value = ("(?:[^"\\]|\\.)*");/.exec(source)[1]);
          return value === "rgba(0, 0, 0, 0)"
            ? { ok: true, rgb: [0, 0, 0], alpha: 0, readBack: value }
            : { ok: true, rgb: [1, 1, 1], alpha: 0.4, readBack: value };
        },
        scan: () => scanResult([["text-0-0", [16, 20, 24, 255]]]),
        verify: () => ({ ok: true, after: afterSnapshot(node) }),
      }),
    );
    return {
      page,
      result: await measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId: "dashboard-default",
        roleCatalog: [m32Role("page.body-text", { selector: "#target" })],
        policy: M31_POLICY,
      }),
    };
  };

  const generated = generateNode();
  assert.deepEqual(generated.node.ownOpacityTextProof, {
    isContentEditable: false,
    isOrdinaryHtmlElement: true,
    hasShadowRoot: false,
    childElementCount: 0,
    directTextOnly: true,
    hasNonEmptyDirectText: true,
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    boxShadow: "none",
    textShadow: "none",
    borderWidths: ["0px", "0px", "0px", "0px"],
    outlineStyle: "none",
    outlineWidth: "0px",
    beforeContent: "normal",
    afterContent: "normal",
    display: "block",
    clipPath: "none",
    maskImage: "none",
    webkitTextStrokeWidth: "0px",
    textEmphasisStyle: "none",
  });
  assert.deepEqual(
    generated.node.chain.map(({ tag, opacity, textDecorationLine }) => [tag, opacity, textDecorationLine]),
    [
      ["span", "0.55", "none"],
      ["body", "1", "none"],
    ],
  );
  const opaque = generateNode({ computed: { opacity: "1" } });
  assert.equal(Object.hasOwn(opaque.node, "ownOpacityTextProof"), false, "普通 opacity=1 探针不增加证明字段");

  const { page, result } = await measure(generated.node, generated.attemptToken);
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);
  const background = [16 / 255, 20 / 255, 24 / 255];
  const expected = contrastRatio(compositeSrgb([1, 1, 1], 0.4 * 0.55, background), background);
  assert.equal(record.result, expected >= record.threshold ? "pass" : "fail");
  assert.equal(record.ratio, expected);
  assert.equal(evidence.worst.foreground.alpha, 0.4 * 0.55);
  assert.deepEqual(evidence.nodes[0].ownOpacityTextProof, generated.node.ownOpacityTextProof);
  assert.equal(generated.node.computed.opacity, "0.55", "测量不得改写目标透明度");
  assert.equal(result.diagnostics.restoration.styleDifferences.length, 0, "文字隐藏后恢复必须无样式差异");
  assert.ok(
    page.evaluations.includes("hide") && page.evaluations.includes("restore") && page.evaluations.includes("verify"),
  );

  const ancestor = generateNode({ parentOpacity: "0.5" });
  const ancestorResult = await measure(ancestor.node, ancestor.attemptToken);
  assert.equal(ancestorResult.result.records[0].result, "unmeasured");
  assert.match(ancestorResult.result.records[0].reason, /body 的 opacity=0\.5/);

  const generatedPseudo = generateNode({ pseudo: { content: '"PRIVATE_GENERATED_TEXT"' } });
  assert.equal(generatedPseudo.node.ownOpacityTextProof.beforeContent, "generated");
  assert.equal(generatedPseudo.node.ownOpacityTextProof.afterContent, "generated");
  assert.doesNotMatch(JSON.stringify(generatedPseudo.node), /PRIVATE_GENERATED_TEXT/);

  for (const rejected of [
    generateNode({ descendants: [{ tag: "EM", text: "nested", rect: { x: 100, y: 50, width: 20, height: 20 } }] }),
    generatedPseudo,
    generateNode({ computed: { boxShadow: "0px 1px 2px rgb(0, 0, 0)" } }),
  ]) {
    const rejectedResult = await measure(rejected.node, rejected.attemptToken);
    assert.equal(rejectedResult.result.records[0].result, "unmeasured");
    assert.match(rejectedResult.result.records[0].reason, /无法作为普通文字叶测量/);
  }

  const missingProof = probeNode(0, {
    computed: { ...probeNode(0).computed, opacity: "0.55" },
    chain: [{ tag: "div", opacity: "0.55", filter: "none", mixBlendMode: "normal", backdropFilter: "none" }],
  });
  const missingProofResult = await measure(missingProof);
  assert.equal(missingProofResult.result.records[0].result, "unmeasured");
  assert.match(missingProofResult.result.records[0].reason, /缺少绘制安全字段/);

  const surfaceNode = {
    ...generated.node,
    rect: { x: 0, y: 0, width: 7, height: 7 },
    client: { left: 0, top: 0, width: 7, height: 7 },
  };
  const surfacePage = createScriptedPage(
    defaultHandlers({ "node-probe": () => ({ nodes: [surfaceNode], attemptToken: generated.attemptToken }) }),
  );
  const surfaceResult = await measureBrowserRoles({
    page: surfacePage,
    candidate: null,
    mode: "light",
    stateId: "metric-record-visible",
    roleCatalog: [m32Role("badge.record")],
    policy: M31_POLICY,
  });
  assert.equal(surfaceResult.records[0].result, "unmeasured", "文字证明不得开放 surface 自身 opacity");
  assert.match(surfaceResult.records[0].reason, /opacity/);
});

test("M3.2：恢复核验——恢复后快照与隐藏前不一致时记录差异（不静默）", async () => {
  const nodes = [probeNode(0)];
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      verify: () => ({
        ok: true,
        after: { ...afterSnapshot(nodes[0]), rect: { x: 101, y: 50, width: 200, height: 20 } },
      }),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.deepEqual(result.diagnostics.restoration.rectDifferences, ["page.body-text#0"]);
  assert.deepEqual(result.diagnostics.restoration.styleDifferences, []);
});

test("M3.2 返工回归：恢复侧 inlineRestored=false 必须被调用方消费并记入诊断", async () => {
  const nodes = [probeNode(0)];
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: false }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: false, after: afterSnapshot(nodes[0]) }),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  // 只生成字段不检查等于没做恢复核验：恢复与核验两处都要落账
  assert.deepEqual(result.diagnostics.restoration.inlineRestoreFailures, [
    "page.body-text#0: 恢复 内联声明未回到原值",
    "page.body-text#0: 恢复核验 内联声明未回到原值",
  ]);
  // 恢复干净时不误报
  const cleanPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
    }),
  );
  const clean = await measureBrowserRoles({
    page: cleanPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.deepEqual(clean.diagnostics.restoration.inlineRestoreFailures, []);
});

test("M3.2 返工回归：身份失效丢弃整轮样本并重做一次，第二次仍失效记 unmeasured", async () => {
  const nodes = [probeNode(0), probeNode(1)];
  const counts = { hide: 0, roleStartProbe: 0 };
  const identityInvalidPage = createScriptedPage(
    defaultHandlers({
      "node-probe": (source) => {
        // 角色开始探测（trackIdentities=true）才会走建立基准的分支
        if (String(source).includes("const state = true ? __stash()")) counts.roleStartProbe += 1;
        return { nodes, attemptToken: `attempt-${counts.roleStartProbe}` };
      },
      scan: () =>
        scanResult([
          ["text-0-0", [0, 0, 0, 255]],
          ["text-1-0", [0, 0, 0, 255]],
        ]),
      hide: () => {
        counts.hide += 1;
        // 第一次尝试的第一个节点就失效：整轮作废
        return counts.hide === 1
          ? { ok: false, identityInvalid: true, reason: "selector 匹配集合第 0 位已换成新节点" }
          : { ok: true, token: `hide-${counts.hide}`, originals: {} };
      },
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
    }),
  );
  const retried = await measureBrowserRoles({
    page: identityInvalidPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(counts.roleStartProbe, 2, "身份失效必须从新的完整角色快照重做（重新建立一次基准）");
  assert.equal(counts.hide, 3, "重做后第一个节点必须重新隐藏测量，不是从失效点续跑");
  assert.equal(retried.records[0].result, "pass", "第二次尝试有效时用第二次的结果");
  assert.ok(
    retried.diagnostics.notes.some((note) => note.includes("第 1 次角色尝试 DOM 样本失效")),
    "失效过程必须写进诊断",
  );

  // 连续两次失效：不得伪造通过，记 unmeasured 并保留原因
  const alwaysInvalidPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "attempt-always" }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      hide: () => ({ ok: false, identityInvalid: true, reason: "selector 匹配集合数量已变化（2 → 3）" }),
    }),
  );
  const unmeasured = await measureBrowserRoles({
    page: alwaysInvalidPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(unmeasured.records[0].result, "unmeasured");
  assert.match(unmeasured.records[0].reason, /连续两次失效/);
  assert.match(unmeasured.records[0].reason, /数量已变化/);
});

test("B34：动态文字连续两次扫描失效仍恢复并收尾，两张截图都标无效且不混用结果", async () => {
  const nodes = [probeNode(0)];
  const counts = { probe: 0, scan: 0, restore: 0, verify: 0 };
  const released = [];
  const tokenOf = (source) => {
    const raw = /const token = ("(?:[^"\\]|\\.)*");/.exec(String(source))?.[1];
    return raw === undefined ? null : JSON.parse(raw);
  };
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": (source) => {
        if (String(source).includes("const state = true ? __stash()")) counts.probe += 1;
        return { nodes, attemptToken: `a${counts.probe}` };
      },
      hide: () => ({
        ok: true,
        token: `h${counts.scan + 1}`,
        originals: {},
        isolation: { isolated: true, remaining: [] },
      }),
      scan: () => {
        counts.scan += 1;
        return {
          ...scanResult([]),
          identityValid: false,
          reason: "第 0 位宿主：第 0 个直接 Text node 已换成新节点",
        };
      },
      restore: () => {
        counts.restore += 1;
        return { ok: true, identityValid: true, inlineRestored: true };
      },
      verify: () => {
        counts.verify += 1;
        return { ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) };
      },
      "release-attempt": (source) => {
        released.push(tokenOf(source));
        return { ok: true, restoredTargets: 0, releasedSessions: 0, attemptReleased: true };
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(result.records[0].result, "unmeasured");
  assert.equal(result.records[0].ratio, null);
  assert.match(result.records[0].reason, /连续两次失效/);
  assert.match(result.records[0].reason, /直接 Text node 已换成新节点/);
  assert.equal(counts.probe, 2, "第二次必须从新的完整 probe 重做");
  assert.equal(counts.scan, 2);
  assert.equal(counts.restore, 2, "两次 identity 失效都必须恢复，不能跳过 finally");
  assert.equal(counts.verify, 0, "扫描失败后不得伪造恢复核验结果");
  assert.equal(released.length, 2);
  assert.deepEqual([...new Set(released)].length, 2, "两次尝试必须按各自 token 收尾");
  assert.equal(result.captures.length, 2);
  assert.ok(
    result.captures.every((capture) => capture.sampleStatus === "invalidated-dom-identity"),
    "两次失效截图都必须标无效，不能混入最终样本",
  );
});

test("M3.2 返工回归：每个角色尝试都在 finally 释放页内暂存——成功/两次失效/扫描异常三条收尾", async () => {
  const nodes = [probeNode(0)];
  const tokenOf = (source) => {
    const raw = /const token = ("(?:[^"\\]|\\.)*");/.exec(String(source))?.[1];
    return raw === undefined ? null : JSON.parse(raw);
  };
  const releaseOk = { ok: true, restoredTargets: 0, releasedSessions: 0, attemptReleased: true };

  // 1. 正常返回：一次尝试一次收尾，且收尾排在滚动还原之后（样式已恢复才丢引用）
  const releasedOk = [];
  const okPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a1" }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      "release-attempt": (source) => {
        releasedOk.push(tokenOf(source));
        return releaseOk;
      },
    }),
  );
  const ok = await measureBrowserRoles({
    page: okPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(ok.records[0].result, "pass");
  assert.deepEqual(releasedOk, ["a1"], "正常返回也要释放本次尝试的基准与暂存");
  assert.ok(
    okPage.evaluations.lastIndexOf("release-attempt") > okPage.evaluations.lastIndexOf("scroll-restore"),
    "收尾必须排在滚动还原之后",
  );

  // 2. 连续两次失效：每次尝试各释放一次，按尝试 token 清，不误删
  const releasedInvalid = [];
  const invalidPage = createScriptedPage(
    defaultHandlers({
      "node-probe": (source) => {
        const round = /const state = true \? __stash\(\)/.test(String(source)) ? releasedInvalid.length + 1 : 0;
        return { nodes, attemptToken: `a${round}` };
      },
      hide: () => ({ ok: false, identityInvalid: true, reason: "selector 匹配集合第 0 位已换成新节点" }),
      "release-attempt": (source) => {
        releasedInvalid.push(tokenOf(source));
        return releaseOk;
      },
    }),
  );
  const invalid = await measureBrowserRoles({
    page: invalidPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(invalid.records[0].result, "unmeasured");
  assert.equal(releasedInvalid.length, 2, "失效重做后第二次尝试也必须收尾");
  assert.deepEqual(
    [...new Set(releasedInvalid)].sort(),
    [...releasedInvalid].sort(),
    "每次收尾用的 token 必须各不相同（按尝试清，不误删别的会话）",
  );

  // 3. 扫描异常：异常照旧抛出，但收尾照样跑（不能只在正常出口收尾）
  const releasedThrow = [];
  const throwPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a9" }),
      scan: () => {
        throw new TypeError("PNG 解码失败");
      },
      "release-attempt": (source) => {
        releasedThrow.push(tokenOf(source));
        return releaseOk;
      },
    }),
  );
  await assert.rejects(
    () =>
      measureBrowserRoles({
        page: throwPage,
        candidate: null,
        mode: "light",
        stateId: "dashboard-default",
        roleCatalog: [m32Role("page.body-text")],
        policy: M31_POLICY,
      }),
    /PNG 解码失败/,
  );
  assert.deepEqual(releasedThrow, ["a9"], "扫描异常也必须走同一收尾");
  assert.ok(throwPage.evaluations.includes("scroll-restore"), "扫描异常时滚动也要还原");
});

test("M3.2 返工回归：隐藏后隔离失效记 unmeasured，不得把污染样本记成 contrast fail", async () => {
  const nodes = [probeNode(0)];
  const leakedPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a1" }),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: false, remaining: ["span"] },
      }),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
      scan: () => scanResult([["text-0-0", [69, 86, 102, 255]]]),
    }),
  );
  const leaked = await measureBrowserRoles({
    page: leakedPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = leaked.records[0];
  assert.equal(record.result, "unmeasured", "隔离失效的样本不是真实低对比，只能记 unmeasured");
  assert.equal(record.ratio, null, "不得给出污染样本的比值");
  assert.match(record.reason, /隐藏后仍检测到文字绘制/);
  assert.match(record.reason, /span/);
  // 隔离失败也要把样式恢复回去再放弃这个节点
  assert.ok(
    leakedPage.evaluations.includes("restore") && leakedPage.evaluations.includes("verify"),
    "隔离失败后仍必须恢复并核验",
  );
  assert.deepEqual(leaked.diagnostics.restoration.inlineRestoreFailures, []);

  // 隔离有效时不受影响：正常走完并给出真实比值
  const cleanPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a1" }),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
    }),
  );
  const clean = await measureBrowserRoles({
    page: cleanPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(clean.records[0].result, "pass");
});

test("M3.2 返工回归：解码后复核发现隔离失效同样记 unmeasured，恢复/核验/释放照常", async () => {
  // 反例：隐藏样式写完时隔离是好的，随后同一个对象在截图窗口里重新拿到文字填充。
  // 这一轮由 buildScanSource 在 image.decode() 之后、真实目标尚未恢复时复核，
  // 返回 isolationValid=false（与 identityValid=false 分开），调用方据此拒绝污染样本。
  const nodes = [probeNode(0)];
  const lateFillPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a1" }),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
      scan: () => ({
        ...scanResult([["text-0-0", [69, 86, 102, 255]]]),
        identityValid: true,
        isolationValid: false,
        isolationReason: "隐藏后仍检测到文字绘制（span 保留独立文字填充/阴影）",
      }),
    }),
  );
  const rejected = await measureBrowserRoles({
    page: lateFillPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = rejected.records[0];
  assert.equal(record.result, "unmeasured", "解码后隔离失效必须拒绝样本，不得记 contrast fail");
  assert.notEqual(record.result, "fail");
  assert.equal(record.ratio, null, "不得给出污染样本的比值");
  assert.match(record.reason, /像素扫描时/);
  assert.match(record.reason, /隐藏后仍检测到文字绘制/);
  assert.match(record.reason, /span/);
  // 恢复/核验/释放照常执行，且不触发身份重做（隔离失效不是身份问题）
  assert.ok(lateFillPage.evaluations.includes("restore"), "隔离失效后仍必须恢复");
  assert.ok(lateFillPage.evaluations.includes("verify"), "隔离失效后仍必须核验");
  assert.ok(lateFillPage.evaluations.includes("release-attempt"), "隔离失效后仍必须收尾释放");
  assert.equal(
    lateFillPage.evaluations.filter((tag) => tag === "hide").length,
    1,
    "隔离失效不做身份重做（只有一次角色尝试，即只有一次隐藏）",
  );
  assert.deepEqual(rejected.diagnostics.restoration.inlineRestoreFailures, []);

  // 解码后复核隔离仍然有效时照常出真实比值（新检查不得把好样本挡掉）
  const goodPage = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes, attemptToken: "a1" }),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(nodes[0]) }),
      scan: () => ({
        ...scanResult([["text-0-0", [0, 0, 0, 255]]]),
        identityValid: true,
        isolationValid: true,
        isolationReason: null,
      }),
    }),
  );
  const good = await measureBrowserRoles({
    page: goodPage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(good.records[0].result, "pass");
  assert.ok(good.records[0].ratio > 1);
});

test("M3.2 返工回归：后一带解码后判隔离失效——本节点前半段的带一并作废，不得判 contrast fail", async () => {
  // 反例的下一层：第 1 带的比值本身低于阈值（真实或被污染都算），第 2 带解码后
  // 才判出隔离失效。assembleRoleRecord 先看"有没有低于阈值的已测样本"、再看"有没有
  // 未测样本"，所以只拒绝第 2 带、留着第 1 带，会让这个没测完的节点直接判 contrast fail。
  const tall = probeNode(0, {
    rect: { x: 100, y: 50, width: 200, height: 900 },
    textRects: [{ x: 100, y: 50, width: 200, height: 20 }],
  });
  const short = probeNode(0, {
    rect: { x: 100, y: 50, width: 200, height: 100 },
    textRects: [{ x: 100, y: 50, width: 200, height: 20 }],
    scroll: { x: 0, y: 700 },
  });
  let probeCalls = 0;
  let scanCalls = 0;
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => {
        probeCalls += 1;
        // 1 = 角色基准，2 = 第 1 带逐带重探，3 = 第 2 带逐带重探
        return { nodes: [probeCalls <= 2 ? tall : short], attemptToken: "a1" };
      },
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
      verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(short) }),
      scan: () => {
        scanCalls += 1;
        // 两带都取到与前景同色的背景：color-parse 替身给的前景是 rgb[1,1,1]（0–1 空间的
        // 白），所以 255/255/255 的背景算出来正好是比值 1.0 < 阈值 4.5。第 1 带隔离有效，
        // 第 2 带失效——只留第 1 带就会让这个没测完的节点判成 contrast fail。
        const base = scanResult([["text-0-0", [255, 255, 255, 255]]]);
        if (scanCalls === 1) {
          return { ...base, identityValid: true, isolationValid: true, isolationReason: null };
        }
        return {
          ...base,
          identityValid: true,
          isolationValid: false,
          isolationReason: "隐藏后仍检测到文字绘制（span 保留独立文字填充/阴影）",
        };
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(scanCalls, 2, "本用例必须真的走到第二带（否则测不到作废逻辑）");
  assert.notEqual(record.result, "fail", "没测完的节点不得因为前半段的带被判 contrast fail");
  assert.equal(record.result, "unmeasured");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /像素扫描时/);
  assert.match(record.reason, /一并作废/);
  assert.match(record.reason, /已记的 1 个带样本/);
  assert.ok(page.evaluations.includes("restore") && page.evaluations.includes("verify"), "拒绝后仍要恢复并核验");
  assert.ok(page.evaluations.includes("release-attempt"), "拒绝后仍要收尾释放");
});

test("M3.2 返工回归：surface 路径两条隔离出口都记 unmeasured（隐藏时与解码后）", async () => {
  const surfaceRole = () =>
    m32Role("spotlight.tinted-surface", {
      kind: "graphic",
      selector: ".race-surface",
      threshold: 3,
      required: true,
      background: { kind: "solid", color: { kind: "var", name: "--panel" } },
    });
  const runSurface = (page) =>
    measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId: "spotlight-on",
      roleCatalog: [surfaceRole()],
      policy: M31_POLICY,
    });
  const surfaceNodes = [probeNode(0, { computed: { ...probeNode(0).computed, backgroundColor: "rgb(69, 86, 102)" } })];
  const base = () => ({
    "node-probe": () => ({ nodes: surfaceNodes, attemptToken: "a1" }),
    restore: () => ({ ok: true, identityValid: true, inlineRestored: true }),
    verify: () => ({ ok: true, identityValid: true, inlineRestored: true, after: afterSnapshot(surfaceNodes[0]) }),
  });

  // 1) 隐藏时自身填充没被清干净
  const hideLeakPage = createScriptedPage(
    defaultHandlers({
      ...base(),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: false, remaining: ["background-color"] },
      }),
      scan: () => ({ ...scanResult([["surface-0-0", [1, 1, 1, 255]]]), identityValid: true, isolationValid: true }),
    }),
  );
  const hideLeak = await runSurface(hideLeakPage);
  assert.equal(hideLeak.records[0].result, "unmeasured", "隐藏时隔离失效必须记 unmeasured");
  assert.notEqual(hideLeak.records[0].result, "fail");
  assert.equal(hideLeak.records[0].ratio, null);
  assert.match(hideLeak.records[0].reason, /隐藏后自身填充仍未清空/);
  assert.match(hideLeak.records[0].reason, /background-color/);
  assert.ok(
    hideLeakPage.evaluations.includes("restore") && hideLeakPage.evaluations.includes("verify"),
    "surface 隐藏时隔离失效后仍必须恢复并核验",
  );
  assert.deepEqual(hideLeak.diagnostics.restoration.inlineRestoreFailures, []);

  // 2) 隐藏时干净、解码后发现自身填充被写回来
  const latePage = createScriptedPage(
    defaultHandlers({
      ...base(),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      scan: () => ({
        ...scanResult([["surface-0-0", [1, 1, 1, 255]]]),
        identityValid: true,
        isolationValid: false,
        isolationReason: "隐藏后仍检测到文字绘制（background-color）",
      }),
    }),
  );
  const late = await runSurface(latePage);
  assert.equal(late.records[0].result, "unmeasured", "解码后隔离失效必须记 unmeasured");
  assert.notEqual(late.records[0].result, "fail");
  assert.equal(late.records[0].ratio, null);
  assert.match(late.records[0].reason, /像素扫描时/);
  assert.match(late.records[0].reason, /一并作废/);
  assert.ok(latePage.evaluations.includes("release-attempt"), "surface 拒绝样本后仍要收尾释放");

  // 3) 两条出口都没触发时照常出真实比值（新守卫不得挡掉好样本）
  const cleanPage = createScriptedPage(
    defaultHandlers({
      ...base(),
      hide: () => ({
        ok: true,
        token: "h1",
        originals: {},
        identityId: 1,
        isolation: { isolated: true, remaining: [] },
      }),
      scan: () => ({
        ...scanResult([["surface-0-0", [0, 0, 0, 255]]]),
        identityValid: true,
        isolationValid: true,
        isolationReason: null,
      }),
    }),
  );
  const clean = await runSurface(cleanPage);
  assert.equal(clean.records[0].result, "pass", "surface 好样本必须照常判 pass");
  assert.ok(clean.records[0].ratio > 1);
});

test("M3.2：canvas 路径——绘制按角色分类、观察坐标按 buffer/CSS 尺寸比换算、恢复核验通过", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      scan: () => scanResult([["draw-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("chart.axis-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.method, "browser-canvas-observer");
  // multiply 文字是本角色的绘制却测不动：计入缺测，整体 unmeasured——不许拿已测
  // 的那一条充成完整覆盖（此前直接判 pass）
  assert.equal(record.result, "unmeasured");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /覆盖不完整/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.canvasId, "timelineChart", "画布选择器取自背景对象的 canvasSelector");
  assert.deepEqual(evidence.clip, { x: 40, y: 300, width: 400, height: 120 }, "clip = 画布 CSS 盒 + 滚动偏移");
  // 坐标换算：观察记录里的 (x, y) 是 drawing buffer 像素，取样区域是 CSS 像素
  assert.deepEqual(
    evidence.canvasScale,
    { x: 400 / 960, y: 120 / 320 },
    "buffer→CSS 尺寸比必须记进证据（DPR>1 时截图按 CSS 盒截取）",
  );
  assert.equal(evidence.draws.length, 1, "混合模式绘制、底色层填充与图形绘制都不计入文字角色");
  assert.equal(evidence.measuredCount, 1, "可测的那条绘制照常测量");
  assert.equal(evidence.unmeasuredCount, 1, "测不动的 multiply 文字计入缺测");
  assert.ok(
    evidence.unmeasuredReasons.some((reason) => reason.includes("multiply")),
    "缺测原因必须说明是哪条绘制、为什么测不动",
  );
  assert.equal(evidence.worst.ratio, contrastRatio([1, 1, 1], [0, 0, 0]), "已测绘制的比值仍写进证据，不因缺测被抹掉");
  const draw = evidence.draws[0];
  assert.equal(draw.method, "fillText");
  assert.equal(draw.text, "L1");
  assert.equal(draw.colorValue, "#ffffff", "颜色取自观察记录，不从 paletteChartSeries 推断");
  assert.deepEqual(draw.parsed, { rgb: [1, 1, 1], alpha: 1 }, "颜色经浏览器 canvas 解析");
  // transform {a:2,b:0,c:0,d:2,e:10,f:20} + textAlign=right + ascent=9、descent=3：
  // anchorX = 100 − 20 = 80；buffer 基线 = (2·80+10, 2·50+20) = (170, 120)，
  // 框 = (170, 120−18, 40, 24)；再按 400/960、120/320 换算成 CSS 像素
  assert.equal(closeTo(draw.rect.x, 40 + 170 * (400 / 960)), true, "横坐标按 buffer/CSS 比换算");
  assert.equal(closeTo(draw.rect.y, 300 + (120 - 18) * (120 / 320)), true, "纵坐标按 buffer/CSS 比换算");
  assert.equal(closeTo(draw.rect.width, 40 * (400 / 960)), true, "宽度按 buffer/CSS 比换算");
  assert.equal(closeTo(draw.rect.height, 24 * (120 / 320)), true, "高度按 buffer/CSS 比换算");
  assert.equal(evidence.skipped.length, 2, "跳过的绘制必须逐条记账，不静默");
  assert.deepEqual(
    evidence.skipped.map((entry) => entry.reason),
    // 顺序跟随观察记录：底色层 fillRect 在 multiply 文字之前
    ["文字角色只测文字绘制，图形绘制不计入本角色", "非 source-over 合成（multiply）无法单独取样"],
  );
  assert.deepEqual(result.diagnostics.restoration.canvasDifferences, [], "bitmap 恢复无差异");
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes("重建底色层 1")),
    "自绘底层按观察记录重建并记录",
  );
  assert.equal(result.captures.at(-1).kind, "background");
  assert.equal(page.evaluations.includes("canvas-clear"), true);
  assert.equal(page.evaluations.includes("canvas-restore"), true);
});

test("M3.2：图形 canvas 角色只测图形绘制——画布上只有 fillText 时必须缺测，不得沿用文字绘制充数", async () => {
  // 回归：轴文字与堆叠段共用同一份观察记录。此前不分类，chart.timeline-segment
  // 会把 fillText 记录当成自己的绘制，画布只有文字时也给出 PASS。
  const page = createScriptedPage(
    defaultHandlers({
      scan: () => scanResult([["draw-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("chart.timeline-segment")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "unmeasured", "只有文字绘制的画布上，图形角色不得判通过");
  assert.equal(record.ratio, null);
  assert.equal(record.threshold, 3, "缺测角色仍保留目录阈值");
  assert.match(record.reason, /graphic.*可测的当前帧绘制|可测的当前帧绘制/);
  assert.match(record.reason, /图形角色只测图形绘制/);
  const evidence = JSON.parse(record.evidence);
  assert.deepEqual(evidence.draws, [], "没有任何绘制计入图形角色");
  assert.ok(
    evidence.skipped.every((entry) => entry.reason.length > 0),
    "每条跳过的绘制都带原因",
  );
  assert.ok(
    evidence.skipped.some((entry) => entry.reason.includes("图形角色只测图形绘制")),
    "文字绘制被图形角色跳过时必须说明原因",
  );
  assert.ok(
    evidence.skipped.some((entry) => entry.reason.includes("底色层")),
    "应用自绘底色层被跳过时必须说明原因",
  );
  assert.deepEqual(result.diagnostics.restoration.canvasDifferences, [], "缺测也要正常恢复画布");
});

test("M3.2：图形 canvas 角色测堆叠段——fillRect 区域按 transform 与 buffer/CSS 比换算", async () => {
  const records = [
    {
      method: "fillText",
      fillStyle: "#00ff00",
      alpha: 1,
      composite: "source-over",
      transform: null,
      rectArgs: null,
      frame: 0,
      text: "轴标",
      x: 3,
      y: 4,
      measured: { width: 8, ascent: 9, descent: 3 },
    },
    {
      method: "fillRect",
      fillStyle: "#00ff00",
      alpha: 1,
      composite: "source-over",
      transform: { a: 2, b: 0, c: 0, d: 2, e: 5, f: 7 },
      rectArgs: [10, 20, 30, 40],
      frame: 1,
      text: null,
    },
    {
      method: "fillRect",
      fillStyle: "#123456",
      alpha: 1,
      composite: "source-over",
      transform: null,
      rectArgs: [0, 0, 960, 320],
      frame: 1,
      text: null,
    },
  ];
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => ({
        ok: true,
        selector: "#timelineChart",
        canvasId: "timelineChart",
        frame: 1,
        bitmap: { width: 960, height: 320 },
        cssRect: { x: 40, y: 300, width: 400, height: 120 },
        scroll: { x: 0, y: 0 },
        dpr: 2,
        records,
      }),
      scan: () => scanResult([["draw-0", [0, 0, 0, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("chart.timeline-segment")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "pass");
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.drawFrame, 1, "本轮使用的帧号必须记进证据");
  assert.equal(evidence.draws.length, 1, "只测堆叠段：文字绘制与底色层都不计入图形角色");
  assert.equal(evidence.draws[0].colorValue, "#00ff00");
  assert.equal(evidence.draws[0].method, "fillRect");
  // buffer 坐标：x = 2·10+5 = 25，y = 2·20+7 = 47，60×80；再按 400/960、120/320 换算成 CSS
  assert.equal(closeTo(evidence.draws[0].rect.x, 40 + 25 * (400 / 960)), true);
  assert.equal(closeTo(evidence.draws[0].rect.y, 300 + 47 * (120 / 320)), true);
  assert.equal(closeTo(evidence.draws[0].rect.width, 60 * (400 / 960)), true);
  assert.equal(closeTo(evidence.draws[0].rect.height, 80 * (120 / 320)), true);
});

test("M3.2：canvas 路径当前帧零条记录——清空/重置后没重绘时缺测，不清画布也不截图", async () => {
  // 回归：帧号取自"记录里的最大帧号"时，空白画布仍会按旧帧的轴文字返回 PASS。
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => ({
        ok: true,
        selector: "#timelineChart",
        canvasId: "timelineChart",
        frame: 2,
        bitmap: { width: 960, height: 320 },
        cssRect: { x: 40, y: 300, width: 400, height: 120 },
        scroll: { x: 0, y: 0 },
        dpr: 1,
        records: [],
      }),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("chart.axis-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "unmeasured", "当前帧一条绘制都没有，不得判通过");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /没有任何绘制记录/);
  assert.match(record.reason, /不沿用旧帧/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.drawFrame, 2, "帧号仍写进证据");
  assert.deepEqual(evidence.draws, [], "没有任何绘制进入测量");
  assert.equal(page.evaluations.includes("canvas-clear"), false, "没有可测绘制时不得清空画布");
  assert.equal(page.evaluations.includes("canvas-restore"), false, "没动过画布就无需恢复");
  assert.equal(page.evaluations.includes("scroll-restore"), true, "滚动会话照常还原");
  assert.deepEqual(result.diagnostics.restoration.canvasDifferences, [], "没有画布变动就没有画布差异");
});

test("M3.2：canvas 路径里本角色测不动的绘制计入缺测——可测 fillRect 加路径 stroke 不得记 pass", async () => {
  const captureAndMeasure = async ({
    background,
    observationError = false,
    chartDraw = null,
    mutateChartDraw = false,
  }) => {
    const dom = createFrameObserverStubDom();
    dom.sandbox.window.scrollX = 0;
    dom.sandbox.window.scrollY = 0;
    dom.sandbox.window.devicePixelRatio = 1;
    assert.equal(runInNewContext(buildColorObserverSource(), dom.sandbox), "installed");
    dom.ctx.fillStyle = "#000000";
    dom.ctx.fillRect(10, 20, 30, 40);
    dom.ctx.strokeStyle = "#101010";
    dom.ctx.lineWidth = 2;
    dom.ctx.globalAlpha = 0.75;
    if (observationError) {
      dom.ctx.getTransform = () => {
        throw new Error("transform observer failed");
      };
    }
    if (chartDraw) dom.ctx.__codexUsageChartDraw = chartDraw;
    dom.ctx.stroke();
    if (chartDraw && mutateChartDraw) {
      chartDraw.roleId = "mutated-after-stroke";
      chartDraw.points[0][0] = 999;
    }
    delete dom.ctx.__codexUsageChartDraw;
    let stashReads = 0;
    const page = createScriptedPage(
      defaultHandlers({
        "canvas-stash": () => {
          stashReads += 1;
          return runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), dom.sandbox);
        },
        "color-parse": () => ({ ok: true, rgb: [0, 0, 0], alpha: 1, readBack: "#000000" }),
        scan: () => scanResult([["draw-0", background]]),
      }),
    );
    const result = await measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId: "dense-data",
      roleCatalog: [m32Role("chart.timeline-segment")],
      policy: M31_POLICY,
    });
    return { record: result.records[0], stashReads };
  };

  const { record, stashReads } = await captureAndMeasure({ background: [255, 255, 255, 255] });
  assert.equal(stashReads, 2, "真实 canvas-stash 分别供初始和 live 读取");
  assert.equal(record.result, "unmeasured", "本角色有绘制却没测全：不得拿已测那部分冒充完整覆盖");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /覆盖不完整/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 1, "可测的那条绘制照常测量");
  assert.equal(evidence.unmeasuredCount, 1, "路径型 stroke 属于本角色，计入缺测");
  assert.ok(evidence.unmeasuredReasons.some((reason) => reason.includes("路径型 stroke")));
  assert.equal(evidence.draws.length, 1, "可测绘制仍写进证据，不因缺测被删掉");
  assert.equal(evidence.worst.ratio, contrastRatio([0, 0, 0], [1, 1, 1]));
  const skippedStroke = evidence.skipped.find((entry) => entry.method === "stroke");
  assert.deepEqual(
    hostValue(skippedStroke),
    {
      method: "stroke",
      text: null,
      reason: "绘制机制没有可取样参数（路径型 stroke/fill 只记调用，不记矩形与坐标）",
      eventSequence: 1,
      frame: 0,
      canvasId: "timelineChart",
      strokeStyle: "#101010",
      lineWidth: 2,
      alpha: 0.75,
      composite: "source-over",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    },
    "只保留白名单身份字段，不把 canvas/context/调用参数泄入报告",
  );

  const { record: failed } = await captureAndMeasure({ background: [0, 0, 0, 255] });
  assert.equal(failed.result, "fail", "低于阈值的 fillRect 仍先判 fail，未知 stroke 不会遮盖失败");
  assert.equal(failed.ratio, 1);
  const failedEvidence = JSON.parse(failed.evidence);
  assert.equal(failedEvidence.unmeasuredCount, 1);
  assert.equal(failedEvidence.skipped.find((entry) => entry.method === "stroke").eventSequence, 1);

  const { record: observerFailed } = await captureAndMeasure({
    background: [255, 255, 255, 255],
    observationError: true,
  });
  assert.equal(observerFailed.result, "unmeasured");
  const observerFailure = JSON.parse(observerFailed.evidence).skipped.find((entry) => entry.method === "stroke");
  assert.equal(observerFailure.eventSequence, 1);
  assert.equal(observerFailure.canvasId, "timelineChart");
  assert.equal(observerFailure.lineWidth, 2);
  assert.match(observerFailure.observationError, /transform observer failed/);

  const originalChartDraw = {
    roleId: "chart.axis-line",
    points: [
      [64, 18],
      [64, 278],
      [942, 278],
    ],
  };
  const { record: tagged } = await captureAndMeasure({
    background: [255, 255, 255, 255],
    chartDraw: originalChartDraw,
    mutateChartDraw: true,
  });
  assert.equal(tagged.result, "pass", "D6b3 将已确认轴线从数据段覆盖中分离");
  const taggedStroke = JSON.parse(tagged.evidence).skipped.find((entry) => entry.method === "stroke");
  assert.deepEqual(
    hostValue(taggedStroke.chartDraw),
    {
      roleId: "chart.axis-line",
      points: [
        [64, 18],
        [64, 278],
        [942, 278],
      ],
    },
    "快照不引用调用方对象，后续修改不改变留存身份",
  );
  assert.equal(taggedStroke.chartDrawInvalidReason, undefined);
  assert.equal(JSON.parse(tagged.evidence).unmeasuredCount, 0);

  for (const [chartDraw, reason] of [
    [
      {
        roleId: "unknown.axis",
        points: [
          [64, 18],
          [64, 278],
          [942, 278],
        ],
      },
      "unsupported-role-id",
    ],
    [
      {
        roleId: "chart.axis-line",
        points: [
          [64, 18],
          [64, 278],
        ],
      },
      "invalid-points",
    ],
    [
      {
        roleId: "chart.axis-line",
        points: [
          [64, 18],
          [64, 278],
          [Number.NaN, 278],
        ],
      },
      "invalid-points",
    ],
  ]) {
    const { record: invalid } = await captureAndMeasure({ background: [255, 255, 255, 255], chartDraw });
    assert.equal(invalid.result, "unmeasured");
    const invalidStroke = JSON.parse(invalid.evidence).skipped.find((entry) => entry.method === "stroke");
    assert.equal(invalidStroke.chartDraw, undefined, "未登记或不完整元数据不能形成有效身份");
    assert.equal(invalidStroke.chartDrawInvalidReason, reason);
  }
});

const measureCanvasRolesThroughObserver = async ({
  roleIds,
  background = [255, 255, 255, 255],
  chartDraw,
  chartDrawPresent = chartDraw !== undefined,
  observationError = false,
  composite = "source-over",
}) => {
  const dom = createFrameObserverStubDom();
  dom.sandbox.window.scrollX = 0;
  dom.sandbox.window.scrollY = 0;
  dom.sandbox.window.devicePixelRatio = 1;
  assert.equal(runInNewContext(buildColorObserverSource(), dom.sandbox), "installed");
  dom.ctx.fillStyle = "#000000";
  dom.ctx.fillRect(10, 20, 30, 40);
  dom.ctx.strokeStyle = "#000000";
  dom.ctx.lineWidth = 1;
  dom.ctx.globalCompositeOperation = composite;
  if (chartDrawPresent) dom.ctx.__codexUsageChartDraw = chartDraw;
  if (observationError) {
    dom.ctx.getTransform = () => {
      throw new Error("axis transform observation failed");
    };
  }
  dom.ctx.stroke();
  delete dom.ctx.__codexUsageChartDraw;

  let stashReads = 0;
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => {
        stashReads += 1;
        return runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), dom.sandbox);
      },
      "color-parse": () => ({ ok: true, rgb: [0, 0, 0], alpha: 1, readBack: "#000000" }),
      scan: (source) => {
        const match = /regions: (\[[^\r\n]*\])\.map\(\(region\) =>/.exec(source);
        assert.ok(match, "扫描源包含画布绘制区域");
        return scanResult(JSON.parse(match[1]).map((region) => [region.id, background]));
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: roleIds.map((roleId) => m32Role(roleId)),
    policy: M31_POLICY,
  });
  return { result, stashReads };
};

const measureAxisLineThroughObserver = async ({
  dpr = 1,
  bitmap = { width: 400, height: 120 },
  transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  points = [
    [20, 10],
    [20, 70],
    [100, 70],
  ],
  chartDraw = { roleId: "chart.axis-line", points },
  chartDrawPresent = true,
  lineWidth = 2,
  strokeStyle = "rgba(0, 0, 0, 0.8)",
  fillStyle = "#ffffff",
  alpha = 0.8,
  composite = "source-over",
  observationError = false,
  backgrounds = {
    vertical: [255, 255, 255, 255],
    horizontal: [204, 204, 204, 255],
  },
  missingParts = [],
}) => {
  const dom = createFrameObserverStubDom();
  dom.sandbox.window.scrollX = 0;
  dom.sandbox.window.scrollY = 0;
  dom.sandbox.window.devicePixelRatio = dpr;
  dom.canvas.width = bitmap.width;
  dom.canvas.height = bitmap.height;
  dom.ctx.getTransform = transform === null ? null : () => transform;
  assert.equal(runInNewContext(buildColorObserverSource(), dom.sandbox), "installed");
  dom.ctx.fillStyle = fillStyle;
  dom.ctx.fillRect(10, 20, 30, 40);
  dom.ctx.strokeStyle = strokeStyle;
  dom.ctx.lineWidth = lineWidth;
  dom.ctx.globalAlpha = alpha;
  dom.ctx.globalCompositeOperation = composite;
  if (chartDrawPresent) dom.ctx.__codexUsageChartDraw = chartDraw;
  if (observationError) {
    dom.ctx.getTransform = () => {
      throw new Error("axis transform observation failed");
    };
  }
  dom.ctx.stroke();
  delete dom.ctx.__codexUsageChartDraw;

  const scans = [];
  const missing = new Set(missingParts);
  const parsedColors = {
    "#ffffff": { ok: true, rgb: [1, 1, 1], alpha: 1, readBack: "#ffffff" },
    "rgba(0, 0, 0, 0.8)": { ok: true, rgb: [0, 0, 0], alpha: 0.8, readBack: "rgba(0, 0, 0, 0.8)" },
    "#999999": { ok: true, rgb: [0.6, 0.6, 0.6], alpha: 1, readBack: "#999999" },
  };
  let restoreCalls = 0;
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => runInNewContext(buildProbeSource("canvas-stash", "#timelineChart"), dom.sandbox),
      "color-parse": (source) => {
        const match = /const value = ("[^"\\]*(?:\\.[^"\\]*)*");/.exec(source);
        assert.ok(match, "颜色解析源包含单个已序列化的 value");
        return parsedColors[JSON.parse(match[1])] ?? { ok: false, reason: "test color not registered" };
      },
      scan: (source) => {
        const match = /regions: (\[[^\r\n]*\])\.map\(\(region\) =>/.exec(source);
        assert.ok(match, "扫描源包含传给现有区域扫描器的 rectangles");
        const regions = JSON.parse(match[1]);
        scans.push(regions);
        return {
          width: 220,
          height: 24,
          scale: { x: 1, y: 1 },
          regions: regions.map((region) =>
            missing.has(region.part)
              ? { id: region.id, columns: 0, rows: 0, origin: { x: 0, y: 0 }, pixels: [] }
              : {
                  id: region.id,
                  columns: 2,
                  rows: 1,
                  origin: { x: 0, y: 0 },
                  pixels: pixels(backgrounds[region.part], 2),
                },
          ),
        };
      },
      "canvas-clear": () => ({ ok: true, rebuiltBaseLayers: 0 }),
      "canvas-restore": () => {
        restoreCalls += 1;
        return { ok: true, identical: true, differingPixels: 0 };
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("chart.axis-line")],
    policy: M31_POLICY,
  });
  return { record: result.records[0], scans, page, restoreCalls };
};

test("D6b3/D6b4：已标记轴线从段角色分离，并测量两条轴线窄带", async () => {
  const { result, stashReads } = await measureCanvasRolesThroughObserver({
    roleIds: ["chart.timeline-segment", "chart.axis-line"],
    chartDraw: {
      roleId: "chart.axis-line",
      points: [
        [64, 18],
        [64, 278],
        [942, 278],
      ],
    },
  });
  assert.equal(stashReads, 4, "同一 observer 快照经初始/live stash 供两个角色核验");
  const records = new Map(result.records.map((record) => [record.roleId, record]));
  const segment = records.get("chart.timeline-segment");
  const segmentEvidence = JSON.parse(segment.evidence);
  assert.equal(segment.result, "pass", "轴线不会造成数据段覆盖缺口");
  assert.equal(segmentEvidence.measuredCount, 1);
  assert.equal(segmentEvidence.unmeasuredCount, 0);
  const axisInSegment = segmentEvidence.skipped.find((entry) => entry.method === "stroke");
  assert.equal(axisInSegment.chartDraw.roleId, "chart.axis-line");
  assert.match(axisInSegment.reason, /不属于 chart\.timeline-segment/);

  const axisLine = records.get("chart.axis-line");
  const axisEvidence = JSON.parse(axisLine.evidence);
  assert.equal(axisLine.result, "pass", "D6b4 只扫描两条窄带，轴线与数据段继续分离");
  assert.equal(axisEvidence.draws.length, 2);
  assert.equal(axisEvidence.measuredCount, 2);
  assert.equal(axisEvidence.unmeasuredCount, 0);
  assert.deepEqual(
    axisEvidence.draws.map((draw) => draw.part),
    ["vertical", "horizontal"],
  );
  assert.ok(axisEvidence.draws.every((draw) => draw.chartDraw.roleId === "chart.axis-line"));
  assert.match(
    axisEvidence.skipped.find((entry) => entry.method === "fillRect").reason,
    /属于 chart\.timeline-segment/,
  );
});

test("D6b3：未知轴线、观察失败与混合合成继续缺测，低对比数据段仍优先失败", async () => {
  const validAxis = {
    roleId: "chart.axis-line",
    points: [
      [64, 18],
      [64, 278],
      [942, 278],
    ],
  };
  const cases = [
    { name: "无标签", options: {}, invalidReason: undefined },
    {
      name: "未知角色",
      options: { chartDraw: { ...validAxis, roleId: "chart.other-line" } },
      invalidReason: "unsupported-role-id",
    },
    {
      name: "缺点",
      options: {
        chartDraw: {
          roleId: "chart.axis-line",
          points: [
            [64, 18],
            [64, 278],
          ],
        },
      },
      invalidReason: "invalid-points",
    },
    {
      name: "观察失败",
      options: { chartDraw: validAxis, observationError: true },
      observationError: true,
    },
    {
      name: "混合合成",
      options: { chartDraw: validAxis, composite: "multiply" },
      reason: /非 source-over 合成/,
    },
  ];
  for (const item of cases) {
    for (const roleId of ["chart.timeline-segment", "chart.axis-line"]) {
      const { result } = await measureCanvasRolesThroughObserver({
        roleIds: [roleId],
        ...item.options,
      });
      const record = result.records[0];
      assert.equal(record.result, "unmeasured", `${roleId} 的 ${item.name} stroke 不得冒充可覆盖绘制`);
      const evidence = JSON.parse(record.evidence);
      assert.equal(evidence.unmeasuredCount, 1, `${roleId} 的 ${item.name} 必须计入缺测`);
      const skipped = evidence.skipped.find((entry) => entry.method === "stroke");
      if (item.invalidReason) assert.equal(skipped.chartDrawInvalidReason, item.invalidReason);
      else if (item.name === "无标签") assert.equal(skipped.chartDraw, undefined);
      if (item.observationError) assert.match(skipped.observationError, /axis transform observation failed/);
      if (item.reason) assert.match(skipped.reason, item.reason);
    }
  }

  const { result } = await measureCanvasRolesThroughObserver({
    roleIds: ["chart.timeline-segment"],
    chartDraw: validAxis,
    background: [0, 0, 0, 255],
  });
  assert.equal(result.records[0].result, "fail", "可测 fillRect 比值低于阈值时仍优先 fail");
  assert.equal(result.records[0].ratio, 1);
});

test("D6b4：DPR1/2 的平移均匀缩放轴线只扫描两条线宽窄带并聚合最差样本", async () => {
  const variants = [
    {
      name: "DPR1",
      dpr: 1,
      bitmap: { width: 400, height: 120 },
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      lineWidth: 2,
      expected: [
        { part: "vertical", x: 59, y: 309, width: 2, height: 62 },
        { part: "horizontal", x: 59, y: 369, width: 82, height: 2 },
      ],
    },
    {
      name: "DPR2 with translation",
      dpr: 2,
      bitmap: { width: 800, height: 240 },
      transform: { a: 2, b: 0, c: 0, d: 2, e: 4, f: 6 },
      lineWidth: 1,
      expected: [
        { part: "vertical", x: 61.5, y: 312.5, width: 1, height: 61 },
        { part: "horizontal", x: 61.5, y: 372.5, width: 81, height: 1 },
      ],
    },
  ];
  for (const variant of variants) {
    const { record, scans, restoreCalls } = await measureAxisLineThroughObserver(variant);
    assert.equal(record.result, "pass", `${variant.name} 两臂都达到 3:1`);
    const evidence = JSON.parse(record.evidence);
    assert.equal(evidence.measuredCount, 2);
    assert.equal(evidence.unmeasuredCount, 0);
    assert.deepEqual(
      evidence.draws.map((draw) => draw.part),
      ["vertical", "horizontal"],
    );
    assert.equal(evidence.draws[0].method, "stroke");
    assert.equal(evidence.draws[0].eventSequence, 1);
    assert.equal(evidence.draws[0].frame, 0);
    assert.equal(evidence.draws[0].lineWidth, variant.lineWidth);
    assert.equal(evidence.draws[0].colorValue, "rgba(0, 0, 0, 0.8)", "前景必须取 strokeStyle 而不是白色 fillStyle");
    assert.deepEqual(evidence.draws[0].foreground.rgb, [0, 0, 0]);
    assert.ok(closeTo(evidence.draws[0].foreground.alpha, 0.64), "CSS alpha 与 globalAlpha 相乘");
    assert.deepEqual(evidence.draws[0].chartDraw, {
      roleId: "chart.axis-line",
      points: [
        [20, 10],
        [20, 70],
        [100, 70],
      ],
    });
    assert.equal(scans.length, 1);
    assert.deepEqual(
      scans[0].map(({ part, x, y, width, height }) => ({ part, x, y, width, height })),
      variant.expected,
      `${variant.name} 的两条窄带按 bitmap 变换及 canvasScale 换算到页坐标`,
    );
    assert.ok(
      scans[0].every(({ x, y, width, height }) => !(90 >= x && 90 <= x + width && 340 >= y && 340 <= y + height)),
      "L 形内部的无关背景不能落入任一轴线扫描区域",
    );
    assert.equal(evidence.draws[0].worst.background[0], 255);
    assert.equal(evidence.draws[1].worst.background[0], 204);
    assert.equal(evidence.worst.node, "draw-1", "汇总取水平臂较差的背景样本");
    assert.equal(record.ratio, evidence.draws[1].worst.ratio);
    assert.equal(restoreCalls, 1, "采样后仍走原画布逐像素恢复流程");
  }
});

test("D6b4：坏几何和缺测保留；单臂低对比优先 fail", async () => {
  const invalidCases = [
    {
      name: "退化L形",
      options: {
        points: [
          [20, 10],
          [20, 10],
          [100, 10],
        ],
      },
    },
    {
      name: "反向L形",
      options: {
        points: [
          [20, 70],
          [20, 10],
          [100, 10],
        ],
      },
    },
    { name: "缺lineWidth", options: { lineWidth: null } },
    { name: "缺transform", options: { transform: null } },
    { name: "旋转", options: { transform: { a: 1, b: 0.1, c: 0, d: 1, e: 0, f: 0 } } },
    { name: "剪切", options: { transform: { a: 1, b: 0, c: 0.1, d: 1, e: 0, f: 0 } } },
    { name: "非均匀缩放", options: { transform: { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 } } },
    {
      name: "未知stroke",
      options: {
        chartDraw: {
          roleId: "chart.other-line",
          points: [
            [20, 10],
            [20, 70],
            [100, 70],
          ],
        },
      },
    },
    { name: "无身份stroke", options: { chartDrawPresent: false } },
    { name: "观察失败", options: { observationError: true } },
    { name: "混合合成", options: { composite: "multiply" } },
  ];
  for (const item of invalidCases) {
    const { record, scans, page } = await measureAxisLineThroughObserver(item.options);
    assert.equal(record.result, "unmeasured", `${item.name} 不得形成轴线采样`);
    assert.equal(record.ratio, null);
    assert.equal(JSON.parse(record.evidence).unmeasuredCount, 1, `${item.name} 必须进入缺测账`);
    assert.equal(scans.length, 0, `${item.name} 不调用背景扫描`);
    assert.equal(page.evaluations.includes("canvas-clear"), false, `${item.name} 不清理画布去制造测量样本`);
  }

  const missingArm = await measureAxisLineThroughObserver({ missingParts: ["horizontal"] });
  const missingEvidence = JSON.parse(missingArm.record.evidence);
  assert.equal(missingArm.record.result, "unmeasured", "任一臂没有背景像素时不能把另一臂当作完整覆盖");
  assert.equal(missingEvidence.measuredCount, 1);
  assert.equal(missingEvidence.unmeasuredCount, 1);
  assert.deepEqual(
    missingEvidence.draws.map((draw) => draw.part),
    ["vertical"],
  );
  assert.equal(missingArm.restoreCalls, 1);

  const oneArmFails = await measureAxisLineThroughObserver({
    strokeStyle: "#999999",
    alpha: 1,
    backgrounds: {
      vertical: [255, 255, 255, 255],
      horizontal: [0, 0, 0, 255],
    },
  });
  const failEvidence = JSON.parse(oneArmFails.record.evidence);
  assert.equal(oneArmFails.record.result, "fail", "垂直臂低于 3:1 时不能被达标的水平臂掩盖");
  assert.ok(oneArmFails.record.ratio < 3);
  assert.equal(failEvidence.measuredCount, 2);
  assert.equal(failEvidence.worst.node, "draw-0");

  const missingAndFails = await measureAxisLineThroughObserver({
    strokeStyle: "#999999",
    alpha: 1,
    missingParts: ["horizontal"],
  });
  const partialFailEvidence = JSON.parse(missingAndFails.record.evidence);
  assert.equal(missingAndFails.record.result, "fail", "已测臂明确失败时优先于另一臂缺测");
  assert.ok(missingAndFails.record.ratio < 3);
  assert.equal(partialFailEvidence.measuredCount, 1);
  assert.equal(partialFailEvidence.unmeasuredCount, 1);
});

test("M3.2：canvas 路径明确失败优先于缺测——已测绘制低于阈值记 fail，缺测项并进证据", async () => {
  const records = [
    {
      method: "fillRect",
      fillStyle: "#ffffff",
      alpha: 1,
      composite: "source-over",
      transform: null,
      rectArgs: [10, 20, 30, 40],
      frame: 1,
      text: null,
    },
    {
      method: "fill",
      fillStyle: "#ffffff",
      alpha: 1,
      composite: "source-over",
      transform: null,
      rectArgs: null,
      frame: 1,
      text: null,
    },
  ];
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => ({
        ok: true,
        selector: "#timelineChart",
        canvasId: "timelineChart",
        frame: 1,
        bitmap: { width: 960, height: 320 },
        cssRect: { x: 40, y: 300, width: 400, height: 120 },
        scroll: { x: 0, y: 0 },
        dpr: 1,
        records,
      }),
      scan: () => scanResult([["draw-0", [255, 255, 255, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dense-data",
    roleCatalog: [m32Role("chart.timeline-segment")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "fail", "已有明确失败：缺测不得把它盖成 unmeasured");
  assert.equal(record.ratio, 1, "白前景落在白底上");
  assert.match(record.reason, /最差样本/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 1);
  assert.equal(evidence.unmeasuredCount, 1, "缺测项仍进证据，不因失败被吞掉");
  assert.ok(evidence.unmeasuredReasons.some((reason) => reason.includes("路径型 stroke/fill")));
});

test("M3.2：canvas 路径 strokeText 读描边色——黑填白描不得按填充色下结论", async () => {
  // 回归：统一读 fillStyle 时，黑填充白描边的 strokeText 会按黑色测量，白底上
  // 也给出 PASS、ratio=21。
  const records = [
    {
      method: "strokeText",
      fillStyle: "#000000",
      strokeStyle: "#ffffff",
      alpha: 1,
      composite: "source-over",
      font: "12px sans-serif",
      textAlign: "left",
      transform: null,
      text: "轴标",
      x: 10,
      y: 20,
      rectArgs: null,
      measured: { width: 24, ascent: 9, descent: 3 },
      frame: 1,
    },
  ];
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => ({
        ok: true,
        selector: "#timelineChart",
        canvasId: "timelineChart",
        frame: 1,
        bitmap: { width: 960, height: 320 },
        cssRect: { x: 40, y: 300, width: 400, height: 120 },
        scroll: { x: 0, y: 0 },
        dpr: 1,
        records,
      }),
      // 值敏感的替身：把 #ffffff 解析成白、其余解析成黑——否则无论读 fillStyle
      // 还是 strokeStyle 都拿到同一个前景色，比值层面就分不出对错。
      "color-parse": (source) => {
        const embedded = /const value = ("(?:[^"\\]|\\.)*")/.exec(source)?.[1];
        const value = embedded ? JSON.parse(embedded) : "";
        const white = value === "#ffffff";
        return { ok: true, rgb: white ? [1, 1, 1] : [0, 0, 0], alpha: 1, readBack: value };
      },
      scan: () => scanResult([["draw-0", [255, 255, 255, 255]]]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("chart.axis-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "fail", "白色描边落在白底上必须判败");
  assert.equal(record.ratio, 1);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.draws.length, 1);
  assert.equal(evidence.draws[0].method, "strokeText");
  assert.equal(evidence.draws[0].colorValue, "#ffffff", "strokeText 的前景色取自描边色");
  assert.deepEqual(evidence.draws[0].parsed, { rgb: [1, 1, 1], alpha: 1 });
});

test("M3.2：canvas 路径里观察失败的绘制计入缺测——本角色只有失败记录时不得判通过", async () => {
  const records = [
    {
      method: "fillText",
      canvasRef: "#timelineChart",
      frame: 1,
      injected: false,
      observationError: "度量失败",
      text: null,
      x: null,
      y: null,
      rectArgs: null,
    },
  ];
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-stash": () => ({
        ok: true,
        selector: "#timelineChart",
        canvasId: "timelineChart",
        frame: 1,
        bitmap: { width: 960, height: 320 },
        cssRect: { x: 40, y: 300, width: 400, height: 120 },
        scroll: { x: 0, y: 0 },
        dpr: 1,
        records,
      }),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("chart.axis-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "unmeasured", "观察失败的绘制不得从覆盖率里蒸发");
  assert.equal(record.ratio, null);
  assert.match(record.reason, /观察器记录该绘制时出错/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.equal(evidence.measuredCount, 0);
  assert.equal(evidence.draws.length, 0, "失败记录拿不到任何可取样参数");
  assert.equal(page.evaluations.includes("canvas-clear"), false, "无可测绘制时不清画布");
});

test("M3.2：覆盖不完整不得记 pass——一个节点可测、另一个因 opacity 无法隔离时整角色 unmeasured", async () => {
  // 回归：此前汇总只留有 worst 的项，缺测节点连原因一起被 filter 掉，角色仍拿
  // 已测节点的比值记 PASS（伪造覆盖率）。
  const nodes = [
    probeNode(0),
    probeNode(1, {
      chain: [
        { tag: "span", opacity: "1", filter: "none", mixBlendMode: "normal", backdropFilter: "none" },
        { tag: "body", opacity: "0.5", filter: "none", mixBlendMode: "normal", backdropFilter: "none" },
      ],
    }),
  ];
  const page = createScriptedPage(defaultHandlers({ "node-probe": () => ({ nodes }) }));
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "unmeasured", "有已渲染节点没能测量时不得判通过");
  assert.equal(record.ratio, null, "unmeasured 不得携带比值");
  assert.match(record.reason, /覆盖不完整/);
  assert.match(record.reason, /opacity/);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 1);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.equal(evidence.unmeasuredReasons.length, 1, "缺测原因必须保留");
  assert.equal(evidence.worst.ratio, contrastRatio([1, 1, 1], [0, 0, 0]), "已测部分的最差值仍写进证据供复核");
});

test("M3.2：未渲染节点单独记账——不参与覆盖判定，但数量与原因都写进证据，不静默删除", async () => {
  const hidden = probeNode(1);
  hidden.rect = { x: 0, y: 0, width: 0, height: 0 };
  hidden.computed = { ...probeNode(1).computed, display: "none" };
  const page = createScriptedPage(defaultHandlers({ "node-probe": () => ({ nodes: [probeNode(0), hidden] }) }));
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "pass", "display:none 的节点没有可测像素，不构成覆盖缺口");
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.measuredCount, 1);
  assert.equal(evidence.notRenderedCount, 1);
  assert.equal(evidence.unmeasuredCount, 0);
  assert.match(evidence.notRenderedReasons[0], /display:none/, "未渲染原因必须写进证据");
});

test("M3.2：明确失败优先于缺测——已有失败时记 fail，缺测项并进证据不掩盖失败", async () => {
  const nodes = [
    probeNode(0),
    probeNode(1, {
      computed: { ...probeNode(1).computed, opacity: "0.5" },
      chain: [{ tag: "div", opacity: "0.5", filter: "none", mixBlendMode: "normal", backdropFilter: "none" }],
    }),
  ];
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes }),
      // 可测节点也远低于阈值：失败必须盖过覆盖缺口
      scan: () =>
        scanResult([
          ["text-0-0", [255, 255, 255, 255]],
          ["text-1-0", [255, 255, 255, 255]],
        ]),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "fail");
  assert.ok(record.ratio < 4.5);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.equal(evidence.unmeasuredReasons.length, 1);
});

test("M3.2：清前景失败时记 unmeasured 且照常恢复画布——异常不许吞掉测量，也不许跳过恢复", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      "canvas-clear": () => {
        throw new Error("画布已被移除");
      },
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("chart.axis-text")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  assert.equal(record.result, "unmeasured");
  assert.match(record.reason, /清前景失败/);
  assert.equal(page.evaluations.includes("canvas-restore"), true, "清理抛错后仍必须恢复 bitmap");
  assert.equal(page.evaluations.includes("scroll-restore"), true, "清理抛错后仍必须恢复滚动");
});

test("M3.2：滚动恢复核验结果进入 diagnostics——不一致不许只留在页内", async () => {
  const page = createScriptedPage(
    defaultHandlers({
      "scroll-restore": () => ({ ok: true, restored: false, mismatches: ["容器滚动未还原（0/0 → 571/0）"] }),
    }),
  );
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.deepEqual(
    result.diagnostics.restoration.scrollDifferences,
    ["page.body-text: 文字路径容器滚动未还原（0/0 → 571/0）"],
    "滚动没还原 = 测量改动了页面，必须记进诊断",
  );
});

test("M3.2：不可隔离与未定义机制的出口——unmeasured + 原图 + 手工方法，不猜数值", async () => {
  // 1. 叠加层（聚光）：无法与底部分离
  const layered = createScriptedPage(defaultHandlers());
  const layeredResult = await measureBrowserRoles({
    page: layered,
    candidate: null,
    mode: "light",
    stateId: "spotlight-on",
    roleCatalog: [
      m32Role("spotlight.tinted-surface", {
        kind: "graphic",
        threshold: 3,
        required: true,
      }),
    ],
    policy: M31_POLICY,
  });
  const layeredRecord = layeredResult.records[0];
  assert.equal(layeredRecord.result, "unmeasured");
  assert.equal(layeredRecord.ratio, null);
  assert.equal(layeredRecord.method, "unmeasured");
  assert.match(layeredRecord.reason, /叠加层|聚光/);
  const layeredEvidence = JSON.parse(layeredRecord.evidence);
  assert.ok(layeredEvidence.manualMethod.length > 0, "附手工测量方法");
  // 目录选择器是"选择器 + 中文描述"的混合串，页内解析不了：原因写进证据，不猜
  assert.equal(layeredEvidence.capture, null);
  assert.match(layeredEvidence.captureNote, /选择器无法解析/);

  // 1b. 选择器干净带伪元素后缀时：按基选择器定位宿主并留原图
  const pseudoLayered = createScriptedPage(defaultHandlers());
  const pseudoResult = await measureBrowserRoles({
    page: pseudoLayered,
    candidate: null,
    mode: "light",
    stateId: "spotlight-on",
    roleCatalog: [
      m32Role("spotlight.tinted-surface", {
        kind: "graphic",
        selector: "input::after",
        threshold: 3,
        required: true,
        background: { kind: "layered", browserRequired: true, description: "合成测试" },
      }),
    ],
    policy: M31_POLICY,
  });
  const pseudoEvidence = JSON.parse(pseudoResult.records[0].evidence);
  assert.equal(pseudoEvidence.capture, 0, "::after 交给 querySelectorAll 会抛错：按基选择器取原图");
  assert.equal(pseudoEvidence.captureNote, null);
  assert.equal(
    pseudoLayered.screenshots.some((shot) => !shot.fullPage),
    true,
    "原图按视口 clip 截取",
  );

  // 2. 独立合成 HTML graphic 的显式前景：不借真实焦点目录验证通用拒测合同
  const graphic = createScriptedPage(defaultHandlers());
  const graphicResult = await measureBrowserRoles({
    page: graphic,
    candidate: null,
    mode: "light",
    stateId: "keyboard-focus",
    roleCatalog: [
      {
        // M0 仅接受登记身份；只借合法 ID，行为字段全部合成，不读取产品角色。
        id: "graphic.repo-icon",
        kind: "graphic",
        selector: ".synthetic-graphic",
        states: ["keyboard-focus"],
        foreground: { kind: "var", name: "--blue" },
        background: { kind: "solid", color: { kind: "var", name: "--panel" } },
        required: true,
        threshold: 3,
      },
    ],
    policy: M31_POLICY,
  });
  assert.equal(graphicResult.records[0].result, "unmeasured");
  assert.equal(graphicResult.records[0].ratio, null);
  assert.match(graphicResult.records[0].reason, /HTML 图形角色/);
  const graphicEvidence = JSON.parse(graphicResult.records[0].evidence);
  assert.ok(graphicEvidence.manualMethod.length > 0);
  // 显式有效 selector 留存原图，不会把无通用测量机制变为可测。
  assert.equal(graphicEvidence.capture, 0);
  assert.equal(graphicEvidence.captureNote, null);
  assert.equal(
    graphic.screenshots.some((shot) => !shot.fullPage),
    true,
    "合成图形留原图，仍然拒绝猜测比值",
  );

  // 3. 节点探测失败（选择器无法解析）
  const broken = createScriptedPage(
    defaultHandlers({ "node-probe": () => ({ error: "选择器无法解析：not a selector" }) }),
  );
  const brokenResult = await measureBrowserRoles({
    page: broken,
    candidate: null,
    mode: "light",
    stateId: "input-focus",
    roleCatalog: [m32Role("input.placeholder")],
    policy: M31_POLICY,
  });
  assert.equal(brokenResult.records[0].result, "unmeasured");
  assert.match(brokenResult.records[0].reason, /选择器无法解析/);

  // 4. 状态内无匹配节点
  const empty = createScriptedPage(defaultHandlers({ "node-probe": () => ({ nodes: [] }) }));
  const emptyResult = await measureBrowserRoles({
    page: empty,
    candidate: null,
    mode: "light",
    stateId: "input-focus",
    roleCatalog: [m32Role("input.placeholder")],
    policy: M31_POLICY,
  });
  assert.equal(emptyResult.records[0].result, "unmeasured");
  assert.match(emptyResult.records[0].reason, /未找到选择器匹配/);

  // 5. 无法隔离的祖先滤镜（卡面步骤 7）
  const filtered = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({
        nodes: [
          probeNode(0, {
            chain: [
              { tag: "span", opacity: "1", filter: "none", mixBlendMode: "normal", backdropFilter: "none" },
              { tag: "body", opacity: "0.5", filter: "none", mixBlendMode: "normal", backdropFilter: "none" },
            ],
          }),
        ],
      }),
      scan: () => scanResult([]),
    }),
  );
  const filteredResult = await measureBrowserRoles({
    page: filtered,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(filteredResult.records[0].result, "unmeasured");
  assert.match(filteredResult.records[0].reason, /opacity/, "祖先整体 opacity 不得乘进前景 alpha 冒充正确");
});

const C25_DETAIL_SELECTOR = "#detailPanel #detailList > .bar-row > .bar-track > .bar-fill";
const C25_DETAIL_CLIP_WIDTH = 96;
const c25StackEntry = (overrides = {}) => ({
  source: "test",
  position: "static",
  zIndex: "auto",
  isolation: "auto",
  display: "block",
  visibility: "visible",
  opacity: "1",
  transform: "none",
  filter: "none",
  mixBlendMode: "normal",
  ...overrides,
});
const c25ActiveSpotlight = () => ({
  active: true,
  backgroundImage: "radial-gradient(circle, rgba(10, 20, 30, 0.22), transparent)",
  maskImage: 'url("data:image/svg+xml,spotlight")',
  zIndex: "0",
  activeHostCount: 1,
  activeHostIsPanel: true,
  pseudo: {
    content: '""',
    position: "absolute",
    inset: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    opacity: "1",
    pointerEvents: "none",
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
  },
  host: { isolation: "isolate", position: "relative" },
  x: "120px",
  y: "130px",
  radius: "320px",
  mask: 'url("data:image/svg+xml,mask")',
  stack: {
    heading: c25StackEntry({ position: "relative", zIndex: "1" }),
    labels: [c25StackEntry({ position: "relative", zIndex: "1" })],
    fill: c25StackEntry(),
    track: c25StackEntry(),
    list: c25StackEntry({ display: "grid" }),
    row: c25StackEntry({ display: "grid" }),
  },
});
const c25Geometry = (rowIndex, active = false) => {
  const y = 20 + rowIndex * 20;
  return {
    status: "observed",
    fillRect: { x: 10, y, width: 100, height: 8 },
    visibleRect: { x: 10, y, width: 100, height: 8 },
    radius: 4,
    rowIndex,
    viewport: { width: 800, height: 600, dpr: 1, visualScale: 1 },
    scroll: {
      window: { x: 0, y: 0 },
      list: { left: 0, top: 0, width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
    },
    structure: {
      detailPanel: "section#detailPanel.detail-panel",
      detailList: "div#detailList.bar-list",
      row: `div.bar-row:nth-child(${rowIndex + 1})`,
      track: "div.bar-track",
      fill: "div.bar-fill",
    },
    clipShapes: [
      { rect: { x: 10, y, width: 100, height: 8 }, radius: 4, source: "fill-inner" },
      { rect: { x: 8, y: y - 2, width: 104, height: 12 }, radius: 6, source: "track-inner" },
      { rect: { x: 0, y: 0, width: 200, height: 200 }, radius: 9, source: "ancestor-inner" },
    ],
    spotlight: active
      ? c25ActiveSpotlight()
      : { active: false, backgroundImage: "none", maskImage: "none", zIndex: "auto" },
  };
};
const c25FillSnapshot = (geometry) => ({
  connected: true,
  tag: "div",
  id: "",
  className: "bar-fill",
  rect: { ...geometry.fillRect },
  viewport: { width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0 },
  style: {
    display: "block",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "auto",
    backgroundColor: "rgb(0, 0, 0)",
    backgroundImage: "none",
  },
});
const c25DetailPanel = () => ({
  connected: true,
  tag: "section",
  id: "detailPanel",
  className: "panel detail-panel",
  activeHostCount: 1,
  activeHostIsPanel: true,
  fillInPanel: true,
});
const c25DetailNode = (index, identityId) => ({
  index,
  identityId,
  tag: "div",
  id: "",
  className: "bar-fill",
  hostType: null,
  inputType: null,
});
const c25Strip = (rgba, first = null) =>
  Array.from({ length: C25_DETAIL_CLIP_WIDTH }, (_, index) => (index === 0 && first ? first : rgba)).flat();
const c25DecodedFrames = (argument, scenario) => {
  const rowOf = (base64) => {
    const text = Buffer.from(base64, "base64").toString();
    const match = /^c25-row-(\d+)-/.exec(text);
    if (!match) throw new Error(`C25 未知帧：${text}`);
    return Number(match[1]);
  };
  const row = rowOf(argument.normal);
  if (rowOf(argument.background) !== row || rowOf(argument.verify) !== row) {
    throw new Error("C25 三帧未绑定同一行");
  }
  const foreground = scenario.rows[row];
  if (!Array.isArray(foreground)) throw new Error(`C25 缺少第 ${row} 行前景`);
  const normalFirst = [...foreground, 255];
  const verifyFirst = scenario.restoreDiffRows.includes(row)
    ? [Math.max(0, foreground[0] - 1), foreground[1], foreground[2], 255]
    : normalFirst;
  return {
    normal: { width: C25_DETAIL_CLIP_WIDTH, height: 1, data: c25Strip(normalFirst) },
    background: { width: C25_DETAIL_CLIP_WIDTH, height: 1, data: c25Strip([0, 0, 0, 255]) },
    verify: { width: C25_DETAIL_CLIP_WIDTH, height: 1, data: c25Strip(normalFirst, verifyFirst) },
  };
};
function createC25DetailPage({
  rows,
  active = false,
  restoreDiffRows = [],
  hardScreenshotIndex = null,
  disposeFailureIndex = null,
  nodeIdSnapshots = [],
  primitiveDecodeIndex = null,
  primitiveDecodeValue,
  scrollHandlers = {},
} = {}) {
  const scenario = { rows, active, restoreDiffRows };
  const baselineIds = rows.map((_, index) => index + 1);
  let nodeProbeCalls = 0;
  let clipScreenshotIndex = 0;
  let decodeCalls = 0;
  let disposedCount = 0;
  const screenshotError = new Error("C25 injected C9 screenshot failure");
  const cleanupError = new Error("C25 injected ElementHandle dispose failure");
  const base = createScriptedPage(
    defaultHandlers({
      "node-probe": () => {
        const ids = nodeProbeCalls === 0 ? baselineIds : (nodeIdSnapshots[nodeProbeCalls] ?? baselineIds);
        const result = {
          nodes: ids.map((identityId, index) => c25DetailNode(index, identityId)),
          attemptToken: nodeProbeCalls === 0 ? "c25-attempt" : null,
        };
        nodeProbeCalls += 1;
        return result;
      },
      ...scrollHandlers,
    }),
  );
  const geometryCalls = rows.map(() => 0);
  const handles = rows.map((_, rowIndex) => {
    const geometry = c25Geometry(rowIndex, active);
    const snapshot = c25FillSnapshot(geometry);
    const panel = active ? c25DetailPanel() : null;
    return {
      async evaluate(fn, argument) {
        if (fn.name === "probeDetailBarGeometry") {
          if (geometryCalls[rowIndex] === 0) base.evaluations.push(`c9-baseline-${rowIndex}`);
          geometryCalls[rowIndex] += 1;
          return JSON.parse(JSON.stringify(geometry));
        }
        if (fn.name === "beginDetailBarPaintHide") return { status: "hidden" };
        if (fn.name === "restoreDetailBarPaintHide") {
          return { status: "restored", changed: true, pollution: [] };
        }
        if (fn.name === "installDetailBarHitStash") {
          return { status: "installed", snapshot, detailPanel: panel };
        }
        if (fn.name === "readDetailBarDomHits") {
          return {
            status: "observed",
            hits: argument.points.map((point) => ({
              ...point,
              exactFill: true,
              withinFill: true,
              top: { tag: "div", id: "", className: "bar-fill", connected: true },
              error: null,
            })),
          };
        }
        if (fn.name === "readDetailBarHitSnapshot") {
          return { status: "observed", snapshot, detailPanel: panel };
        }
        if (fn.name === "clearDetailBarHitStash") {
          return { status: "cleared", changed: true, ownerMatches: true };
        }
        if (fn.name === "detailFillHandleMatches") return { valid: true, reason: "" };
        throw new Error(`C25 未预期的 fill.evaluate：${fn.name}`);
      },
      async dispose() {
        disposedCount += 1;
        if (rowIndex === disposeFailureIndex) throw cleanupError;
      },
    };
  });
  const cdpSession = () => {
    let objectId = 0;
    let backendNodeId = 0;
    return {
      async send(method) {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Runtime.evaluate") return { result: { objectId: `object-${++objectId}` } };
        if (method === "DOM.getNodeForLocation") {
          return { backendNodeId: ++backendNodeId, frameId: "main" };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: `hit-${++objectId}` } };
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: active
                ? {
                    exactFill: false,
                    withinFill: false,
                    fillConnected: true,
                    expectedDetailSpotlight: true,
                    rejected: false,
                    reason: "",
                    top: { kind: "non-node", constructorName: "CSSPseudoElement", type: "::after" },
                  }
                : {
                    exactFill: true,
                    withinFill: true,
                    fillConnected: true,
                    expectedDetailSpotlight: false,
                    rejected: false,
                    reason: "",
                    top: { tag: "div", id: "", className: "bar-fill", connected: true },
                  },
            },
          };
        }
        if (method === "Runtime.releaseObjectGroup" || method === "DOM.describeNode") return {};
        if (method === "detach") return {};
        throw new Error(`C25 未预期的 CDP 方法：${method}`);
      },
      async detach() {},
    };
  };
  const page = {
    ...base,
    async evaluate(source, argument) {
      if (typeof source === "function" && source.name === "decodeDetailBarFramesInPage") {
        const index = decodeCalls;
        decodeCalls += 1;
        if (index === primitiveDecodeIndex) throw primitiveDecodeValue;
        return c25DecodedFrames(argument, scenario);
      }
      return base.evaluate(source, argument);
    },
    async screenshot(options) {
      if (!options?.clip) return base.screenshot(options);
      const index = clipScreenshotIndex;
      clipScreenshotIndex += 1;
      if (index === hardScreenshotIndex) throw screenshotError;
      const row = Math.floor(index / 3);
      const frame = ["normal", "background", "verify"][index % 3];
      return Buffer.from(`c25-row-${row}-${frame}`);
    },
    context() {
      return {
        async newCDPSession() {
          return cdpSession();
        },
      };
    },
    async $$(selector) {
      assert.equal(selector, C25_DETAIL_SELECTOR);
      return handles;
    },
  };
  return {
    page,
    screenshotError,
    cleanupError,
    get disposedCount() {
      return disposedCount;
    },
  };
}
function runC25Detail(
  page,
  stateId,
  role = m32Role("chart.detail-fill", { threshold: 3, required: true }),
  options = {},
) {
  return measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId,
    roleCatalog: [role],
    policy: M31_POLICY,
    ...options,
  });
}

test("C25：chart.detail-fill 逐行复用 C9+B41，覆盖与硬错边界不误报", async (t) => {
  await t.test("三行全部有效时取最差行的比值并对阈值 3 判定", async () => {
    const rows = [
      [255, 255, 255],
      [128, 128, 128],
      [10, 10, 10],
    ];
    const harness = createC25DetailPage({ rows });
    const result = await runC25Detail(harness.page, "dashboard-default");
    const record = result.records[0];
    const evidence = JSON.parse(record.evidence);
    const expectedWorst = contrastRatio(
      rows[2].map((value) => value / 255),
      [0, 0, 0],
    );

    assert.equal(record.result, "fail");
    assert.equal(record.ratio, expectedWorst);
    assert.equal(record.threshold, 3);
    assert.equal(record.method, "browser-detail-fill-pixels");
    assert.equal(evidence.rowCount, 3);
    assert.equal(evidence.measuredCount, 3);
    assert.equal(evidence.worst.index, 2);
    assert.equal(evidence.worst.ratio, expectedWorst);
    assert.match(record.reason, /最差行 .* < 阈值 3/);
    assert.equal(result.diagnostics.detailFill.complete, true);
    assert.equal(result.diagnostics.detailFill.worst.index, 2);
    assert.equal(result.captures.length, 9);
    assert.ok(result.captures.every((capture) => !capture.kind.includes("undefined")));
    assert.equal(JSON.stringify(evidence).includes("pngBase64"), false);
    assert.equal(harness.disposedCount, 3);
  });

  await t.test("任一行 B41 未测时整体 unmeasured，已测行和九帧仍保留", async () => {
    const harness = createC25DetailPage({
      rows: [
        [255, 255, 255],
        [128, 128, 128],
        [10, 10, 10],
      ],
      restoreDiffRows: [1],
    });
    const result = await runC25Detail(harness.page, "dashboard-default");
    const record = result.records[0];
    const evidence = JSON.parse(record.evidence);

    assert.equal(record.result, "unmeasured");
    assert.equal(record.ratio, null);
    assert.deepEqual(
      evidence.rows.map((row) => row.status),
      ["measured", "unmeasured", "measured"],
    );
    assert.match(evidence.rows[1].reason, /normal 与 verify|RGBA|不一致/);
    assert.equal(evidence.measuredCount, 2);
    assert.equal(evidence.unmeasuredCount, 1);
    assert.equal(result.captures.length, 9);
  });

  for (const [label, ids] of [
    ["错序", [1, 3, 2]],
    ["替换", [1, 9, 3]],
  ]) {
    await t.test(`第 2 行前${label}使整体 unmeasured，已产三帧保留`, async () => {
      const harness = createC25DetailPage({
        rows: [
          [255, 255, 255],
          [128, 128, 128],
          [10, 10, 10],
        ],
        nodeIdSnapshots: [undefined, undefined, undefined, ids],
      });
      const result = await runC25Detail(harness.page, "dashboard-default");
      const record = result.records[0];
      const evidence = JSON.parse(record.evidence);

      assert.equal(record.result, "unmeasured");
      assert.equal(record.ratio, null);
      assert.match(evidence.coverageFailures[0], /替换或重排/);
      assert.equal(result.captures.length, 3);
      assert.deepEqual(
        result.captures.map((capture) => capture.kind),
        ["detail-fill-row-0-normal", "detail-fill-row-0-background", "detail-fill-row-0-verify"],
      );
      assert.equal(harness.disposedCount, 3);
    });
  }

  await t.test("C9 硬错保留已得帧并从 measurementEvidence 部分证据重抛，同时保留 cleanup 错", async () => {
    const harness = createC25DetailPage({
      rows: [
        [255, 255, 255],
        [128, 128, 128],
        [10, 10, 10],
      ],
      hardScreenshotIndex: 1,
      disposeFailureIndex: 2,
    });

    await assert.rejects(runC25Detail(harness.page, "dashboard-default"), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /详情填充测量失败且清理失败/);
      assert.strictEqual(error.errors[0], harness.screenshotError);
      assert.strictEqual(error.errors[1], harness.cleanupError);
      assert.equal(error.measurementEvidence.complete, false);
      assert.equal(error.measurementEvidence.captures.length, 1);
      assert.equal(error.measurementEvidence.captures[0].kind, "detail-fill-row-0-normal");
      const detailFill = error.measurementEvidence.diagnostics.detailFill;
      assert.equal(detailFill.rowCount, 3);
      assert.deepEqual(
        detailFill.rows.map((row) => row.status),
        ["hard-error", "not-attempted", "not-attempted"],
      );
      assert.equal(detailFill.measuredCount, 0);
      assert.equal(detailFill.unmeasuredCount, 3);
      assert.equal(detailFill.worst, null);
      return true;
    });
    assert.equal(harness.disposedCount, 3);
  });

  await t.test("B41 decode 期间最后一行替换在发布前被最终身份核验拒绝", async () => {
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      nodeIdSnapshots: [undefined, undefined, undefined, [9]],
    });
    const result = await runC25Detail(harness.page, "dashboard-default");
    const record = result.records[0];
    const evidence = JSON.parse(record.evidence);

    assert.equal(record.result, "unmeasured");
    assert.equal(record.ratio, null);
    assert.equal(evidence.rows[0].status, "unmeasured");
    assert.match(evidence.coverageFailures[0], /替换或重排/);
    assert.equal(result.captures.length, 3);
    assert.equal(result.diagnostics.detailFill.complete, false);
  });

  for (const primitive of [null, undefined]) {
    await t.test(`B41 抛 ${String(primitive)} 时包装保留 cause 与既有帧/行诊断`, async () => {
      const harness = createC25DetailPage({
        rows: [
          [255, 255, 255],
          [128, 128, 128],
          [10, 10, 10],
        ],
        primitiveDecodeIndex: 1,
        primitiveDecodeValue: primitive,
      });

      await assert.rejects(runC25Detail(harness.page, "dashboard-default"), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(Object.hasOwn(error, "cause"), true);
        assert.strictEqual(error.cause, primitive);
        assert.equal(error.measurementEvidence.complete, false);
        assert.equal(error.measurementEvidence.captures.length, 6);
        const detailFill = error.measurementEvidence.diagnostics.detailFill;
        assert.deepEqual(
          detailFill.rows.map((row) => row.status),
          ["measured", "hard-error", "not-attempted"],
        );
        assert.equal(detailFill.measuredCount, 1);
        assert.equal(detailFill.unmeasuredCount, 2);
        assert.equal(detailFill.worst.index, 0);
        return true;
      });
      assert.equal(harness.disposedCount, 3);
    });
  }

  await t.test("active C9 成功但 B41 恢复差仍如实 unmeasured", async () => {
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      active: true,
      restoreDiffRows: [0],
    });
    const result = await runC25Detail(harness.page, "spotlight-detail-fill");
    const record = result.records[0];
    const evidence = JSON.parse(record.evidence);

    assert.equal(record.result, "unmeasured");
    assert.equal(record.ratio, null);
    assert.equal(evidence.rows[0].capture.spotlightAdmission.status, "admitted");
    assert.equal(evidence.rows[0].capture.hitTest.status, "observed");
    assert.match(evidence.rows[0].reason, /normal 与 verify|RGBA|不一致/);
    assert.equal(result.captures.length, 3);
  });

  await t.test("结果装配失败时仍保留三帧并释放全部 fill 句柄", async () => {
    const assemblyError = new Error("C25 注入结果装配失败");
    let clipCaptures = 0;
    let measured = false;
    const role = m32Role("chart.detail-fill", { required: true });
    Object.defineProperty(role, "threshold", {
      get() {
        if (measured) throw assemblyError;
        return 3;
      },
    });
    const harness = createC25DetailPage({ rows: [[255, 255, 255]] });
    const screenshot = harness.page.screenshot.bind(harness.page);
    harness.page.screenshot = async (options) => {
      const result = await screenshot(options);
      if (options?.clip && ++clipCaptures === 3) measured = true;
      return result;
    };

    await assert.rejects(runC25Detail(harness.page, "dashboard-default", role), (error) => {
      assert.strictEqual(error, assemblyError);
      assert.equal(error.measurementEvidence.complete, false);
      assert.equal(error.measurementEvidence.captures.length, 3);
      assert.equal(error.measurementEvidence.diagnostics.detailFill.complete, true);
      assert.equal(error.measurementEvidence.diagnostics.detailFill.rows[0].status, "measured");
      return true;
    });
    assert.equal(harness.disposedCount, 1);
  });
});

test("B66：详情填充逐行滚动回调适配", async (t) => {
  await t.test("普通状态按行滚动、核验、callback、C9，并在恢复后再次 callback", async () => {
    const harness = createC25DetailPage({
      rows: [
        [255, 255, 255],
        [128, 128, 128],
      ],
      scrollHandlers: {
        "bring-into-view": () => ({ ok: true, scrolled: true, scroll: { x: 0, y: 0 } }),
        "scroll-restore": () => ({ ok: true, restored: true, mismatches: [] }),
      },
    });
    let callbackCalls = 0;
    await runC25Detail(harness.page, "dashboard-default", undefined, {
      detailFillRestingPointer: async () => {
        harness.page.evaluations.push(`callback-${callbackCalls}`);
        callbackCalls += 1;
      },
    });

    const sequence = harness.page.evaluations.filter((tag) =>
      /^(scroll-|bring-into-view|callback-|c9-baseline-)/.test(tag),
    );
    assert.deepEqual(sequence, [
      "scroll-begin",
      "bring-into-view",
      "callback-0",
      "c9-baseline-0",
      "bring-into-view",
      "callback-1",
      "c9-baseline-1",
      "scroll-restore",
      "callback-2",
    ]);
    assert.equal(callbackCalls, 3);
  });

  await t.test("原始 falsy 错误与恢复、收尾 callback 失败共同保留", async () => {
    const restoreError = new Error("B66 注入滚动恢复失败");
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      scrollHandlers: {
        "scroll-restore": () => {
          throw restoreError;
        },
      },
    });
    let callbackCalls = 0;

    await assert.rejects(
      runC25Detail(harness.page, "dashboard-default", undefined, {
        detailFillRestingPointer: async () => {
          callbackCalls += 1;
          if (callbackCalls === 1) throw 0;
          throw null;
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /详情填充测量失败且清理失败/);
        assert.strictEqual(error.cause, 0);
        assert.equal(error.errors.length, 3);
        assert.strictEqual(error.errors[0].cause, 0);
        assert.strictEqual(error.errors[1], restoreError);
        assert.strictEqual(error.errors[2], null);
        return true;
      },
    );
    assert.equal(callbackCalls, 2);
  });

  await t.test("仅滚动恢复失败时聚合文案标明清理失败", async () => {
    const restoreError = new Error("B66 注入仅清理失败");
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      scrollHandlers: {
        "scroll-restore": () => {
          throw restoreError;
        },
      },
    });
    let callbackCalls = 0;

    await assert.rejects(
      runC25Detail(harness.page, "dashboard-default", undefined, {
        detailFillRestingPointer: async () => {
          callbackCalls += 1;
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "详情填充清理失败");
        assert.deepEqual(error.errors, [restoreError]);
        return true;
      },
    );
    assert.equal(callbackCalls, 2);
  });

  await t.test("active spotlight-detail-fill 即使提供 callback 也不滚动或调用", async () => {
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      active: true,
    });
    let callbackCalls = 0;
    await runC25Detail(harness.page, "spotlight-detail-fill", undefined, {
      detailFillRestingPointer: async () => {
        callbackCalls += 1;
      },
    });

    assert.equal(callbackCalls, 0);
    assert.equal(
      harness.page.evaluations.some((tag) => /^(scroll-|bring-into-view)/.test(tag)),
      false,
    );
  });

  await t.test("未提供 callback 时保持旧行为", async () => {
    const harness = createC25DetailPage({ rows: [[255, 255, 255]] });
    const result = await runC25Detail(harness.page, "dashboard-default");

    assert.equal(result.records[0].result, "pass");
    assert.equal(
      harness.page.evaluations.some((tag) => /^(scroll-|bring-into-view)/.test(tag)),
      false,
    );
  });

  await t.test("已有滚动会话时拒绝接管且不 bring、restore 或 callback", async () => {
    const harness = createC25DetailPage({
      rows: [[255, 255, 255]],
      scrollHandlers: {
        "scroll-begin": () => ({ ok: true, alreadyActive: true }),
        "bring-into-view": () => {
          throw new Error("不得接管已有滚动会话");
        },
        "scroll-restore": () => {
          throw new Error("不得恢复他人滚动会话");
        },
      },
    });
    let callbackCalls = 0;

    await assert.rejects(
      runC25Detail(harness.page, "dashboard-default", undefined, {
        detailFillRestingPointer: async () => {
          callbackCalls += 1;
        },
      }),
      /拒绝接管已有滚动会话/,
    );
    assert.equal(callbackCalls, 0);
    assert.deepEqual(
      harness.page.evaluations.filter((tag) => /^(scroll-|bring-into-view)/.test(tag)),
      ["scroll-begin"],
    );
  });

  await t.test("非函数 callback 立即拒绝且不进入测量", async () => {
    const harness = createC25DetailPage({ rows: [[255, 255, 255]] });

    await assert.rejects(
      runC25Detail(harness.page, "dashboard-default", undefined, {
        detailFillRestingPointer: "not-a-function",
      }),
      /detailFillRestingPointer 必须是函数或 null/,
    );
    assert.equal(harness.page.evaluations.length, 0);
  });
});

test("M3.2：输入校验与观察器安装——非法输入立即失败，不进入测量", async () => {
  const page = createScriptedPage(defaultHandlers());
  const base = {
    page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  };
  await assert.rejects(() => measureBrowserRoles({ ...base, mode: "sepia" }), /未知模式/);
  await assert.rejects(() => measureBrowserRoles({ ...base, policy: null }), /policy/);
  await assert.rejects(() => measureBrowserRoles({ ...base, candidate: { id: "" } }), /candidate/);
  await assert.rejects(() => measureBrowserRoles({ ...base, candidate: 42 }), /candidate/);
  await assert.rejects(() => measureBrowserRoles({ ...base, stateId: 42 }), /stateId/);
  await assert.rejects(() => measureBrowserRoles({ ...base, stateId: "no-such-state" }), /没有任何预期角色/);
  await assert.rejects(() => measureBrowserRoles({ ...base, roleCatalog: "nope" }), /roleCatalog/);
  await assert.rejects(() => measureBrowserRoles(null), /options/);

  assert.throws(() => installBrowserColorObserver({}), /addInitScript/);
  assert.throws(() => installBrowserColorObserver(null), /addInitScript/);
  const installed = installBrowserColorObserver(page);
  assert.equal(installed.installed, true);
  assert.ok(installed.observedMethods.includes("fillRect"), "观察方法含 fillRect（应用用它画堆叠段）");
  assert.equal(page.initScripts.length, 1);
  assert.throws(() => buildProbeSource("nope"), /未知皮肤探针标记/);
});

test("M5.2.C-E1d：聚光稳定探针等待有限淡入、取消重查、超时与无关动画边界", async () => {
  const makeHost = (opacity = "0.5") => {
    const values = new Map([
      ["--spotlight-x", "10px"],
      ["--spotlight-y", "20px"],
      ["--spotlight-radius", "80px"],
      ["--spotlight-mask", "url(mask)"],
    ]);
    return {
      id: "detailPanel",
      tagName: "SECTION",
      className: "detail-panel",
      opacity,
      style: { getPropertyValue: (name) => values.get(name) ?? "" },
      getAnimations: () => [],
    };
  };
  const makeAnimation = (host, { delayMs, cancel = false, duration = 120 } = {}) => {
    const animation = {
      playState: "running",
      transitionProperty: "opacity",
      effect: {
        target: host,
        pseudoElement: "::after",
        getComputedTiming: () => ({ duration, endTime: duration, iterations: 1 }),
      },
    };
    let finished;
    Object.defineProperty(animation, "finished", {
      get() {
        if (!finished) {
          finished = new Promise((resolve, reject) => {
            setTimeout(() => {
              animation.playState = cancel ? "idle" : "finished";
              if (!cancel) host.opacity = "1";
              if (cancel) reject(new Error("transition canceled"));
              else resolve();
            }, delayMs);
          });
        }
        return finished;
      },
    });
    return animation;
  };
  const runProbe = async (hosts, budgetMs = 500, documentAnimations = []) => {
    const clockStart = Date.now();
    const sandbox = {
      document: {
        querySelectorAll: (selector) => (selector === ".shell [data-spotlight-active]" ? hosts : []),
        getAnimations: () => documentAnimations,
      },
      getComputedStyle: (host) => ({ opacity: host.opacity }),
      performance: { now: () => Date.now() - clockStart },
      requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 4),
      setTimeout,
      clearTimeout,
    };
    return runInNewContext(buildProbeSource("spotlight-stability", budgetMs), sandbox);
  };

  const beforeHost = makeHost("0.4");
  const beforeAnimation = makeAnimation(beforeHost, { delayMs: 12 });
  const descendantAnimation = {
    playState: "running",
    transitionProperty: "opacity",
    effect: {
      target: { id: "nestedPanel" },
      pseudoElement: "::after",
      getComputedTiming: () => ({ duration: 120, endTime: 120, iterations: 1 }),
    },
    finished: new Promise(() => {}),
  };
  const beforeOptions = [];
  beforeHost.getAnimations = (options) => {
    beforeOptions.push(options);
    return [beforeAnimation, descendantAnimation].filter((animation) => animation.playState === "running");
  };
  const before = await runProbe([beforeHost]);
  assert.equal(before.stable, true, "有限聚光过渡完成并跨帧稳定后才报告稳定");
  assert.ok(beforeOptions.length > 0 && beforeOptions.every((options) => options.subtree === true));
  assert.equal(before.initial[0].opacity, "0.4");
  assert.equal(before.settled[0].opacity, "1");
  assert.equal(before.transitionsWaited, 1);

  const afterHost = makeHost("0.3");
  const canceled = makeAnimation(afterHost, { delayMs: 5, cancel: true });
  const replacement = makeAnimation(afterHost, { delayMs: 8 });
  let animationReads = 0;
  const afterOptions = [];
  afterHost.getAnimations = (options) => {
    afterOptions.push(options);
    animationReads += 1;
    return [canceled, replacement].filter((animation) => animation.playState === "running");
  };
  const after = await runProbe([afterHost]);
  assert.equal(after.stable, true, "取消后重新查询替代过渡");
  assert.ok(afterOptions.length > 0 && afterOptions.every((options) => options.subtree === true));
  assert.equal(after.transitionsWaited, 2);
  assert.ok(animationReads >= 3, "取消后重查并在确认帧后复查");

  const timedOutHost = makeHost("0.2");
  const neverFinishes = {
    playState: "paused",
    transitionProperty: "opacity",
    effect: {
      target: timedOutHost,
      pseudoElement: "::after",
      getComputedTiming: () => ({ duration: 1000, endTime: 1000, iterations: 1 }),
    },
    finished: new Promise(() => {}),
  };
  timedOutHost.getAnimations = () => [neverFinishes];
  const timedOut = await runProbe([timedOutHost], 35);
  assert.equal(timedOut.stable, false);
  assert.equal(timedOut.reason, "budget-exhausted-waiting-transition");
  assert.equal(timedOut.transitionsWaited, 1, "有限暂停态也应被识别并在预算内等待finished");
  assert.ok(timedOut.waitedMs <= 60, "等待遵守小于等于预算的有界时间");

  const missingApi = makeHost();
  delete missingApi.getAnimations;
  const unavailable = await runProbe([missingApi]);
  assert.equal(unavailable.stable, false);
  assert.equal(unavailable.reason, "animation-api-unavailable");

  const unrelatedInfinite = {
    playState: "running",
    transitionProperty: null,
    effect: {
      pseudoElement: null,
      getComputedTiming: () => ({ duration: Infinity, endTime: Infinity, iterations: Infinity }),
    },
    finished: new Promise(() => {}),
  };
  const noSpotlight = await runProbe([], 100, [unrelatedInfinite]);
  assert.equal(noSpotlight.stable, true, "不等待页面其它元素的无限动画");
  assert.equal(noSpotlight.transitionsWaited, 0);

  let stabilityCalls = 0;
  const unstablePage = createScriptedPage(
    defaultHandlers({
      "spotlight-stability": () => {
        stabilityCalls += 1;
        return { stable: false, reason: "budget-exhausted-waiting-transition", budgetMs: 500, waitedMs: 500 };
      },
    }),
  );
  const measuredDespiteUnstableBaseline = await measureBrowserRoles({
    page: unstablePage,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(stabilityCalls, 2, "before/after 两侧各等待一次");
  assert.equal(measuredDespiteUnstableBaseline.diagnostics.restoration.spotlightStability.stable, false);
  assert.equal(measuredDespiteUnstableBaseline.diagnostics.restoration.statePixelDiff.identical, true);
  assert.ok(
    measuredDespiteUnstableBaseline.diagnostics.notes.some((note) => note.includes("不能视为稳定恢复")),
    "相同像素但稳定等待失败时仍明确标为未稳定",
  );
});

// --- C. 真实浏览器集成（M0.4 fixture + Edge） --------------------------------
//
// 卡面验收的五个集成样例 + "raw token 达标但真实叠加失败"的制造案例。M4.1 的
// 服务句柄尚未就绪，本块按卡片步骤 1 自备 fixture 服务（只在本测试内启停），
// 实际落地的接线点以 M4.1 为准。模块不点击菜单、不建 fixture、不导航——状态
// 全部由本块在调用前摆好（聚焦输入框、把指针移到 recessed surface 上）。

/** Playwright 运行时位置：环境变量优先，其次本机 codex 运行时依赖目录。 */
const M32_PLAYWRIGHT_CANDIDATES = [
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE,
  path.join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  ),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

const M32_EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/google-chrome",
];

async function resolveBrowserRuntime() {
  let chromium = null;
  for (const candidate of M32_PLAYWRIGHT_CANDIDATES) {
    const specifier = existsSync(candidate) ? pathToFileURL(candidate).href : candidate;
    try {
      chromium = (await import(specifier)).chromium ?? null;
    } catch {
      chromium = null;
    }
    if (chromium) break;
  }
  const executablePath = M32_EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  return chromium && executablePath ? { chromium, executablePath } : null;
}

// Chromium 把一组端口登记为"不安全端口"，监听即导航失败（ERR_UNSAFE_PORT）。
const M32_UNSAFE_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080, 11211, 12345,
  33060, 40404,
]);

/** 在安全端口区间内挑一个空闲端口（避开 Chromium 不安全端口清单）。 */
const listenOnFreePort = (server) =>
  new Promise((resolve, reject) => {
    let candidate = 31500;
    const attempt = () => {
      while (M32_UNSAFE_PORTS.has(candidate)) candidate += 1;
      if (candidate > 31599) {
        reject(new Error("M3.2 C 层找不到可用测试端口"));
        return;
      }
      const onError = (error) => {
        if (error && error.code === "EADDRINUSE") {
          candidate += 1;
          attempt();
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(candidate);
      });
    };
    attempt();
  });

/** M0 契约信封：只装测量记录（视觉字段固定未评审），readiness 按一致性规则推导。 */
const m32Envelope = (records) => ({
  schemaVersion: 1,
  candidateId: records[0]?.candidateId ?? "official-source",
  candidateHash: "0".repeat(64),
  fast: [],
  browser: records,
  visual: { reviewed: false, verdict: null, notes: "" },
  readiness: records.some((record) => record.result === "fail")
    ? "rejected"
    : records.some((record) => record.result === "unmeasured")
      ? "incomplete"
      : "incomplete",
  failures: [],
  unmeasured: [],
  diagnostics: {},
});

test("M3.2：真实浏览器集成——纯色/渐变/placeholder/聚光/Canvas 五样例、raw token 达标但真实叠加必须失败、状态不变", async (t) => {
  const browserRuntime = await resolveBrowserRuntime();
  if (!browserRuntime) {
    // 浏览器不可用：不得伪造通过，逐角色降级为 ENVIRONMENT_BLOCKED
    const roles = ROLE_CATALOG.filter((role) => role.states.includes("dashboard-default"));
    const result = await measureBrowserRoles({
      page: null,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: roles,
      policy: M31_POLICY,
    });
    assert.equal(result.diagnostics.environmentBlocked, true);
    assert.equal(result.records.length, roles.length);
    assert.ok(
      result.records.every((record) => record.result === "unmeasured" && record.reason.includes("ENVIRONMENT_BLOCKED")),
    );
    t.diagnostic("Playwright/Edge 不可用：真实浏览器样例未执行，仅断言 ENVIRONMENT_BLOCKED 降级");
    return;
  }

  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let context = null;
  try {
    const port = await listenOnFreePort(server);
    const { chromium, executablePath } = browserRuntime;
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      // 观察器必须装在导航之前（addInitScript 只在真实导航时执行）
      installBrowserColorObserver(page);
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
      await page.waitForSelector(".comparison-table thead th", { timeout: 20000 });
      await page.waitForSelector("#timelineChart", { timeout: 20000 });
      const address = page.url();

      const measure = async (stateId, ids) => {
        const result = await measureBrowserRoles({
          page,
          candidate: null,
          mode: "light",
          stateId,
          roleCatalog: ids.map((id) => m32Role(id)),
          policy: M31_POLICY,
        });
        return result;
      };
      const recordOf = (result, id) => result.records.find((record) => record.roleId === id);
      const evidenceOf = (record) => JSON.parse(record.evidence);
      // DPR=1 下记录到的画布文字框（供 DPR=2 对照：同一份 CSS 绘制应给出同一坐标）
      let chartDrawsAtDpr1 = null;
      /** 截图前后不变量：DOM 几何 + 应用偏好 + 真实 root/body 颜色。 */
      const stateSnapshot = async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        return page.evaluate(() => {
          const geometry = {};
          for (const selector of [
            ".metric",
            ".comparison-table thead th",
            "#timelineChart",
            "#modelComparisonSearch",
          ]) {
            const element = document.querySelector(selector);
            const box = element ? element.getBoundingClientRect() : null;
            geometry[selector] = box
              ? [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
              : null;
          }
          const storage = {};
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            storage[key] = window.localStorage.getItem(key);
          }
          const root = getComputedStyle(document.documentElement);
          const body = getComputedStyle(document.body);
          return {
            geometry,
            storage,
            skin: document.documentElement.dataset.skin ?? null,
            theme: document.documentElement.dataset.theme ?? null,
            root: { color: root.color, background: root.backgroundColor },
            body: { color: body.color, background: body.backgroundColor },
          };
        });
      };
      // 应用自己在数据到达后会二次重画时间分布图：先等它收敛，否则整页像素
      // 比对会把应用自身的重画算到测量头上（与测量是否改动页面无关）。
      await page.evaluate(async () => {
        const canvas = document.querySelector("#timelineChart");
        const read = () => canvas.toDataURL();
        let previous = read();
        for (let step = 0; step < 40; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const current = read();
          if (current === previous) return;
          previous = current;
        }
      });
      const snapshotBefore = await stateSnapshot();

      await t.test("纯色 / 渐变 / Canvas 标签：按真实像素测量，截图全部落在视口内，记录过 M0 契约", async () => {
        const result = await measure("dashboard-default", [
          "table.comparison-header",
          "panel.metric-label",
          "chart.axis-text",
        ]);
        const { diagnostics, captures } = result;
        const statePixelDiff = diagnostics.restoration.statePixelDiff;
        const stateDiffKinds = new Map();
        if (statePixelDiff?.identical === false) {
          const binding = diagnostics.restoration.stateDiffCaptures;
          assert.ok(
            Number.isSafeInteger(binding?.before) &&
              binding.after === binding.before + 1 &&
              binding.after < captures.length,
            "状态差异必须绑定连续的前后诊断截图",
          );
          assert.ok(
            diagnostics.restoration.statePixelScope?.kind === "full-page" ||
              diagnostics.restoration.statePixelScope?.kind === "viewport",
            "状态差异截图必须标明整页或视口范围",
          );
          stateDiffKinds.set(binding.before, "state-diff-before");
          stateDiffKinds.set(binding.after, "state-diff-after");
        } else {
          assert.equal(diagnostics.restoration.stateDiffCaptures, undefined, "零差异不得附状态截图");
        }
        const roleIds = new Set(["table.comparison-header", "panel.metric-label", "chart.axis-text"]);
        for (const [index, capture] of captures.entries()) {
          const png = Buffer.from(capture.pngBase64, "base64");
          assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "每张截图必须是 PNG");
          assert.equal(capture.dpr, diagnostics.dpr, "截图 DPR 必须与测量页一致");
          const stateDiffKind = stateDiffKinds.get(index);
          if (stateDiffKind) {
            assert.equal(capture.roleId, null, "状态差异截图不是角色截图");
            assert.equal(capture.kind, stateDiffKind);
            assert.equal(capture.clip, null, "状态差异截图覆盖完整整页或视口");
            assert.deepEqual(capture.scroll, diagnostics.scroll, "状态差异截图必须来自测量基准滚动位置");
            continue;
          }
          assert.ok(roleIds.has(capture.roleId), `未登记角色截图：${String(capture.roleId)}`);
          assert.ok(["original", "background"].includes(capture.kind), `角色截图类型非法：${capture.kind}`);
          assert.ok(
            Number.isFinite(capture.scroll?.x) && Number.isFinite(capture.scroll?.y),
            "角色截图必须记录实际滚动位置",
          );
          const { clip } = capture;
          assert.ok(
            clip.x >= -1 &&
              clip.y >= -1 &&
              clip.x + clip.width <= diagnostics.viewport.width + 1 &&
              clip.y + clip.height <= diagnostics.viewport.height + 1,
            "角色截图一律视口内 clip（fullPage 分带会把 sticky 表头重复钉在每带顶部）",
          );
        }
        assert.equal(
          captures.filter((capture) => capture.roleId === null).length,
          stateDiffKinds.size,
          "无角色截图只能是已绑定的状态差异帧",
        );
        assert.equal(validateAssessment(m32Envelope(result.records)).valid, true, "产出记录逐条过 M0 契约");
        // 整页像素只是粗口径信号：应用自己会因窗口尺寸变化重绘时间分布图，
        // Playwright 的 fullPage 分带捕获对 sticky 元素也有伪影。页面不变性由
        // 逐节点样式/几何核验 + 画布 bitmap 核验 + 下面的 DOM/偏好/root 颜色
        // 快照共同保证；整页差异必须落在诊断里，不许静默。
        assert.ok(statePixelDiff, "整页状态核验必须执行");
        assert.equal(diagnostics.restoration.styleDifferences.length, 0, "文字隐藏/恢复后样式必须还原");
        assert.equal(diagnostics.restoration.rectDifferences.length, 0, "元素几何不得被测量改动");
        assert.equal(diagnostics.restoration.canvasDifferences.length, 0, "画布 bitmap 必须逐像素还原");
        assert.equal(
          diagnostics.restoration.scrollDifferences.length,
          0,
          `滚动会话必须逐个还原（含测量前停在 0 的容器）：${diagnostics.restoration.scrollDifferences.join("；")}`,
        );
        t.diagnostic(
          statePixelDiff.identical
            ? "整页截图前后逐像素一致"
            : `整页差异 ${statePixelDiff.differingPixels} px（应用自身重绘 / sticky 捕获伪影）`,
        );
        if (!statePixelDiff.identical) {
          assert.ok(
            diagnostics.notes.some((note) => note.includes("整页截图前后存在像素差异")),
            "整页差异必须记录在诊断里，不静默",
          );
        }

        const header = recordOf(result, "table.comparison-header");
        assert.equal(header.result, "pass", `sticky 表头实测未达标：${header.reason}`);
        assert.equal(header.method, "browser-text-pixels", "方法字段回报真实测量机制");
        const headerEvidence = evidenceOf(header);
        const headerBands = headerEvidence.nodes.flatMap((node) => node.bands);
        assert.ok(headerBands.length >= 1, "每个匹配节点至少一个完整可见带");
        for (const band of headerBands) {
          assert.equal(typeof band.capture, "number", "每带都留背景截图索引");
          assert.ok(band.worst && Number.isFinite(band.worst.ratio) && band.worst.ratio >= 1, "每带给出有限最差样本");
          assert.ok(Number.isFinite(band.worst.background[3]), "最差样本带 alpha 通道");
        }

        const label = recordOf(result, "panel.metric-label");
        assert.equal(label.result, "pass", `渐变面板小字实测未达标：${label.reason}`);
        const labelEvidence = evidenceOf(label);
        assert.ok(labelEvidence.nodes.length > 1, "渐变面板多节点：汇总取跨节点最差");
        const labelBackgrounds = new Set(
          labelEvidence.nodes.flatMap((node) => node.bands.map((band) => band.worst.background.join(","))),
        );
        assert.ok(labelBackgrounds.size > 1, "渐变取样点取值不同——量的是真实像素而非单点声明");
        // 未渲染节点（.metric 里的 hidden "New" 徽标）单独记账：不参与覆盖判定，
        // 但数量与原因必须留在证据里，不许静默删掉
        assert.ok(labelEvidence.notRenderedCount > 0, "目录选择器命中的未渲染节点必须记账");
        assert.ok(
          labelEvidence.notRenderedReasons.every((reason) => /display:none|尺寸为 0|visibility:hidden/.test(reason)),
          "未渲染原因要写明为什么不能测",
        );
        assert.equal(labelEvidence.unmeasuredCount, 0, "已渲染节点全部测得：不构成覆盖缺口");

        const chart = recordOf(result, "chart.axis-text");
        assert.equal(chart.result, "pass", `画布标签实测未达标：${chart.reason}`);
        const chartEvidence = evidenceOf(chart);
        assert.equal(chartEvidence.kind, "browser-canvas-observer");
        assert.ok(chartEvidence.draws.length >= 10, `观察器应记录到画布文字绘制，实际 ${chartEvidence.draws.length}`);
        for (const draw of chartEvidence.draws) {
          assert.ok(Number.isFinite(draw.rect.x) && draw.rect.width > 0, "每个绘制框都由 transform + measureText 换算");
          // 取样区域必须落在画布 CSS 盒内（bitmap 坐标没换算时会整体放大 dpr 倍）
          assert.ok(draw.rect.x >= chartEvidence.clip.x - 1, "绘制框不得越出画布左边");
          assert.ok(
            draw.rect.x + draw.rect.width <= chartEvidence.clip.x + chartEvidence.clip.width + 1,
            "绘制框不得越出画布右边（buffer 坐标未换算成 CSS 坐标时会越界）",
          );
        }
        assert.equal(diagnostics.restoration.canvasDifferences.length, 0, "画布 bitmap 恢复后逐像素一致");
        assert.match(diagnostics.notes.join("\n"), /视口坐标/);
        chartDrawsAtDpr1 = chartEvidence.draws.map((draw) => ({
          text: draw.text,
          rect: { ...draw.rect },
        }));
      });

      await t.test("alpha placeholder：前景按浏览器解析出的实际 alpha 与真实背景合成", async () => {
        await page.locator("#updatePricingButton").click();
        await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
        const result = await measure("input-focus", ["input.placeholder"]);
        const placeholder = result.records[0];
        assert.ok(["pass", "fail"].includes(placeholder.result), "placeholder 必须给出判定而不是缺测");
        assert.ok(Number.isFinite(placeholder.ratio));
        const evidence = evidenceOf(placeholder);
        assert.ok(evidence.nodes.length >= 1, "聚焦态下应存在可测输入框");
        const radiusEvidence = await page.evaluate(
          (ids) =>
            ids.map((id) => {
              const host = document.getElementById(id);
              const style = host ? getComputedStyle(host) : null;
              return { id, bottomRightRadius: style?.borderBottomRightRadius ?? null };
            }),
          evidence.nodes.map((node) => node.identity.id),
        );
        const radiusById = new Map(radiusEvidence.map(({ id, bottomRightRadius }) => [id, bottomRightRadius]));
        for (const node of evidence.nodes) {
          const points = node.bands.flatMap((band) => band.occlusion.rects.flatMap((rect) => rect.points));
          assert.equal(points.length, 5, "圆角输入框仍保留中心和四角的遮挡核验");
          assert.ok(
            points.every((point) => point.withinHost),
            "圆角角点应命中输入框，而不是其父容器",
          );
          assert.ok(
            node.parsed.alpha > 0 && node.parsed.alpha < 1,
            "placeholder 颜色按 76% 实际 alpha 合成（styles.css color-mix）",
          );
          assert.equal(typeof node.parsed.readBack, "string", "合法性由浏览器自身 canvas 回读确认");
        }
        t.diagnostic(
          `alpha placeholder 圆角探针：${JSON.stringify(
            evidence.nodes.map((node) => {
              const corner = node.bands[0].occlusion.rects[0].points.find((point) => point.kind === "bottomRight");
              return {
                id: node.identity.id,
                radius: radiusById.get(node.identity.id),
                bottomRight: {
                  x: corner.x,
                  y: corner.y,
                  top: corner.top?.id ?? corner.top?.tag,
                  withinHost: corner.withinHost,
                },
              };
            }),
          )}`,
        );
        assert.equal(await page.evaluate(() => document.activeElement?.id), "pricingSearch", "测量不抢焦点");
        // 官方配色当前达不到 4.5（实测约 1.8）：这正是 M3.2 要报出来的真实缺口
        if (placeholder.result === "fail") assert.match(placeholder.reason, /< 阈值 4\.5/);
        await page.locator("#cancelPricingButton").click();
        await page.waitForFunction(() => document.querySelector("#pricingDialog")?.hidden === true);
      });

      await t.test("聚光开关：开状态改变必要文字背后的真实合成背景，叠加层本体记为 not-applicable", async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        const offResult = await measure("dashboard-default", ["panel.metric-label"]);
        const offRatio = recordOf(offResult, "panel.metric-label").ratio;

        const metric = await page.locator(".metric").first().boundingBox();
        // 指针移到 recessed surface 之外的抬升表面：聚光只在这种表面上点亮
        await page.mouse.move(metric.x + 10, metric.y + 10);
        await page.waitForFunction(() => Boolean(document.querySelector("[data-spotlight-active]")), null, {
          timeout: 5000,
        });
        assert.equal(await page.evaluate(() => Boolean(document.querySelector("[data-spotlight-active]"))), true);

        const layered = await measure("spotlight-on", ["spotlight.tinted-surface"]);
        const layeredRecord = layered.records[0];
        assert.equal(layeredRecord.result, "not-applicable", "装饰层退出数值判定，不得伪造 PASS");
        assert.equal(layeredRecord.ratio, null);
        assert.equal(layeredRecord.method, "not-applicable");
        assert.match(evidenceOf(layeredRecord).applicability, /装饰/);

        const onResult = await measure("dashboard-default", ["panel.metric-label"]);
        const onRatio = recordOf(onResult, "panel.metric-label").ratio;
        assert.ok(onRatio < offRatio, `聚光开启后 metric-label 背后实际背景应变差（${offRatio} → ${onRatio}）`);

        // 指针移到 recessed surface 上（输入框）→ 聚光熄灭，比值回到关状态
        const search = await page.locator("#modelComparisonSearch").boundingBox();
        await page.mouse.move(search.x + search.width / 2, search.y + search.height / 2);
        await page.waitForFunction(() => !document.querySelector("[data-spotlight-active]"), null, { timeout: 5000 });
        const afterResult = await measure("dashboard-default", ["panel.metric-label"]);
        assert.ok(
          Math.abs(recordOf(afterResult, "panel.metric-label").ratio - offRatio) < 0.05,
          "聚光熄灭后回到关状态比值",
        );
      });

      await t.test("制造案例：raw token 达标但真实叠加失败——检查器必须失败，移除后回到通过", async () => {
        const header = m32Role("table.comparison-header");
        // raw token 一侧：表头文字色 vs 角色声明的表面色（页面当前皮肤的 CSS 变量）
        const raw = await page.evaluate(() => {
          const element = document.querySelector(".comparison-table thead th");
          const parse = (value) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#010203";
            ctx.fillStyle = value;
            ctx.fillRect(0, 0, 1, 1);
            const data = ctx.getImageData(0, 0, 1, 1).data;
            return [data[0] / 255, data[1] / 255, data[2] / 255];
          };
          return {
            foreground: parse(getComputedStyle(element).color),
            surface: parse(getComputedStyle(document.documentElement).getPropertyValue("--neo-surface").trim()),
          };
        });
        const rawRatio = contrastRatio(raw.foreground, raw.surface);
        assert.ok(rawRatio >= header.threshold, `声明的 token 对比本应达标（实测 ${rawRatio}）`);

        const clean = await measure("dashboard-default", ["table.comparison-header"]);
        const cleanRecord = recordOf(clean, "table.comparison-header");
        assert.equal(cleanRecord.result, "pass");

        // 叠加层用样式表注入的伪元素：应用滚动时重渲染表格也删不掉它
        const overlay = await page.addStyleTag({
          content:
            ".comparison-table thead th::after{content:'';position:absolute;inset:0;background:rgba(0,0,0,0.92);z-index:5;pointer-events:none}",
        });
        assert.notEqual(
          await page.evaluate(
            () => getComputedStyle(document.querySelector(".comparison-table thead th"), "::after").content,
          ),
          "none",
          "注入的叠加层必须真的画在表头上",
        );
        const broken = await measure("dashboard-default", ["table.comparison-header"]);
        const brokenRecord = recordOf(broken, "table.comparison-header");
        assert.equal(brokenRecord.result, "fail", "真实叠加把背景压暗后必须失败——token 达标不作数");
        assert.ok(brokenRecord.ratio < header.threshold, `失败比值 ${brokenRecord.ratio} 应低于阈值`);
        assert.match(brokenRecord.reason, /< 阈值/);
        assert.equal(broken.diagnostics.restoration.styleDifferences.length, 0, "失败不是恢复泄漏造成的");
        assert.equal(broken.diagnostics.restoration.rectDifferences.length, 0);
        assert.equal(validateAssessment(m32Envelope(broken.records)).valid, true);

        await page.evaluate((handle) => handle.remove(), overlay);
        const healed = await measure("dashboard-default", ["table.comparison-header"]);
        assert.equal(recordOf(healed, "table.comparison-header").result, "pass", "移除叠加层后回到通过");
        assert.ok(Math.abs(recordOf(healed, "table.comparison-header").ratio - cleanRecord.ratio) < 1e-9);
      });

      await t.test("状态不变：DOM 几何、应用偏好、真实 root 颜色与未测量前一致", async () => {
        assert.equal(page.url(), address, "模块不导航");
        const snapshotAfter = await stateSnapshot();
        assert.deepEqual(snapshotAfter, snapshotBefore, "整轮测量前后页面状态逐项一致");
      });

      await t.test("DPR=2 真实换算：同一份 CSS 绘制在 deviceScaleFactor=2 下给出同一组取样区域", async () => {
        // 回归：观察记录坐标是 drawing buffer 像素。此前直接当 CSS 像素用，DPR=2
        // 时 CSS 30px 处的轴标被记成 60px，取样落到错误区域。
        assert.ok(chartDrawsAtDpr1 && chartDrawsAtDpr1.length > 0, "先有 DPR=1 的绘制框作对照");
        const scaled = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          deviceScaleFactor: 2,
        });
        let scaledPage = null;
        try {
          scaledPage = await scaled.newPage();
          installBrowserColorObserver(scaledPage);
          await scaledPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
          await scaledPage.waitForSelector("#timelineChart", { timeout: 20000 });
          const result = await measureBrowserRoles({
            page: scaledPage,
            candidate: null,
            mode: "light",
            stateId: "dashboard-default",
            roleCatalog: [m32Role("chart.axis-text")],
            policy: M31_POLICY,
          });
          const record = recordOf(result, "chart.axis-text");
          assert.equal(record.result, "pass", `DPR=2 下画布标签实测未达标：${record.reason}`);
          const evidence = evidenceOf(record);
          assert.equal(evidence.dpr, 2, "确实跑在 deviceScaleFactor=2 的页面上");
          assert.equal(
            closeTo(evidence.canvasScale.x, evidence.cssRect.width / evidence.bitmap.width, 1e-6),
            true,
            "buffer→CSS 尺寸比必须写进证据",
          );
          assert.ok(evidence.bitmap.width > evidence.cssRect.width, "DPR=2 时 drawing buffer 是 CSS 盒的两倍宽");
          assert.equal(evidence.draws.length, chartDrawsAtDpr1.length, "两个页面绘制同一份图表");
          for (const [index, draw] of evidence.draws.entries()) {
            const baseline = chartDrawsAtDpr1[index];
            assert.equal(draw.text, baseline.text, "同一序号的绘制是同一段文字");
            // CSS 绘制坐标与 DPR 无关：换算错了才会整体差一倍
            assert.ok(
              Math.abs(draw.rect.x - baseline.rect.x) < 1.5,
              `横坐标必须与 DPR=1 一致（${draw.rect.x} vs ${baseline.rect.x}）`,
            );
            assert.ok(
              Math.abs(draw.rect.y - baseline.rect.y) < 1.5,
              `纵坐标必须与 DPR=1 一致（${draw.rect.y} vs ${baseline.rect.y}）`,
            );
            assert.ok(
              Math.abs(draw.rect.width - baseline.rect.width) < 1.5,
              `宽度必须与 DPR=1 一致（${draw.rect.width} vs ${baseline.rect.width}）`,
            );
          }
        } finally {
          await scaled.close();
        }
      });
    } finally {
      await context?.close();
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test("M5.2.C-D2b3：真实 Edge 两种装饰隔离、低对比仍失败，异常/重试/遮挡均清理", async (t) => {
  const browserRuntime = await resolveBrowserRuntime();
  if (!browserRuntime) {
    t.diagnostic("Playwright/Edge 不可用：D2b3 真实浏览器回归未执行（不得据此判定通过）");
    return;
  }
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser = null;
  let context = null;
  const blockedRemoteRequests = [];
  const evidenceRoot = path.resolve(
    "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m52-c-d8u14-style-sync/browser/d2b3",
  );
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDir = path.resolve(evidenceRoot, `run-${Date.now()}-${process.pid}`);
  mkdirSync(evidenceDir, { recursive: false });
  const evidence = { card: "M5.2.C-D2b3", browser: null, samples: [], recovery: {}, blockedRemoteRequests };
  try {
    const port = await listenOnFreePort(server);
    const origin = `http://127.0.0.1:${port}`;
    const { chromium, executablePath } = browserRuntime;
    browser = await chromium.launch({ executablePath, headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin || requestUrl.protocol === "data:") return route.continue();
      blockedRemoteRequests.push(requestUrl.href);
      return route.abort();
    });
    const page = await context.newPage();
    installBrowserColorObserver(page);
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.waitForSelector("#calendarZoneSelect", { timeout: 20000 });
    await page.waitForSelector("#updatePricingButton", { timeout: 20000 });
    evidence.browser = { version: browser.version(), executablePath };

    const marker = "data-skin-palette-measurement-decoration";
    const searchRole = m32Role("input.value");
    const zoneRole = m32Role("select.zone-label", { selector: "#calendarZoneSelect" });
    const measure = (targetPage, mode, role) =>
      measureBrowserRoles({
        page: targetPage,
        candidate: null,
        mode,
        stateId: role.id === "input.value" ? "pricing-input-filled" : "dashboard-default",
        roleCatalog: [role],
        policy: M31_POLICY,
      });
    const clipFor = (selector, clientBox = false) =>
      page.evaluate(
        (args) => {
          const element = document.querySelector(args.selector);
          const rect = element.getBoundingClientRect();
          return args.clientBox
            ? {
                x: rect.x + element.clientLeft,
                y: rect.y + element.clientTop,
                width: element.clientWidth,
                height: element.clientHeight,
              }
            : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        },
        { selector, clientBox },
      );
    const snapshot = (selector) =>
      page.evaluate((targetSelector) => {
        const element = document.querySelector(targetSelector);
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const arrow = element.querySelector?.(".calendar-zone-arrow") ?? null;
        const arrowStyle = arrow ? getComputedStyle(arrow) : null;
        return {
          styleAttributePresent: element.hasAttribute("style"),
          styleAttributeValue: element.getAttribute("style"),
          valueLength: typeof element.value === "string" ? element.value.length : null,
          focused: document.activeElement === element,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          client: {
            left: element.clientLeft,
            top: element.clientTop,
            width: element.clientWidth,
            height: element.clientHeight,
          },
          material: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            boxShadow: style.boxShadow,
            borderColor: style.borderColor,
            borderRadius: style.borderRadius,
          },
          markerPresent: element.hasAttribute("data-skin-palette-measurement-decoration"),
          markerValue: element.getAttribute("data-skin-palette-measurement-decoration"),
          arrow: arrow
            ? {
                rect: (() => {
                  const box = arrow.getBoundingClientRect();
                  return { x: box.x, y: box.y, width: box.width, height: box.height };
                })(),
                visibility: arrowStyle.visibility,
                inlineVisibility: arrow.style.getPropertyValue("visibility"),
                inlinePriority: arrow.style.getPropertyPriority("visibility"),
              }
            : null,
        };
      }, selector);
    const pricingDiagnosticSnapshot = () =>
      page.evaluate(() => {
        const geometry = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {
            viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            document: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
            client: {
              x: rect.x + element.clientLeft,
              y: rect.y + element.clientTop,
              left: element.clientLeft,
              top: element.clientTop,
              width: element.clientWidth,
              height: element.clientHeight,
            },
          };
        };
        const input = document.querySelector("#pricingSearch");
        const inputStyle = getComputedStyle(input);
        const placeholderStyle = getComputedStyle(input, "::placeholder");
        const cancelStyle = getComputedStyle(input, "::-webkit-search-cancel-button");
        const backdrop = document.querySelector("#pricingDialog");
        const dialog = backdrop?.querySelector(".pricing-dialog");
        const dialogStyle = dialog ? getComputedStyle(dialog) : null;
        const list = document.querySelector("#pricingModelList");
        const rate = document.querySelector("#usdToCnyRate");
        const form = document.querySelector("#pricingForm");
        const hovered = Array.from(document.querySelectorAll(":hover")).map((element) => ({
          id: element.id || null,
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : null,
        }));
        return {
          scroll: {
            x: scrollX,
            y: scrollY,
            documentX: document.documentElement.scrollLeft,
            documentY: document.documentElement.scrollTop,
          },
          activeElementId: document.activeElement?.id ?? null,
          hovered,
          search: {
            valueLength: input.value.length,
            placeholderLength: input.placeholder.length,
            focused: document.activeElement === input,
            geometry: geometry(input),
            style: {
              color: inputStyle.color,
              backgroundColor: inputStyle.backgroundColor,
              backgroundImage: inputStyle.backgroundImage,
              padding: inputStyle.padding,
              border: inputStyle.border,
              borderRadius: inputStyle.borderRadius,
              boxShadow: inputStyle.boxShadow,
              opacity: inputStyle.opacity,
              textFillColor: inputStyle.webkitTextFillColor,
              textShadow: inputStyle.textShadow,
            },
            placeholder: { color: placeholderStyle.color, opacity: placeholderStyle.opacity },
            searchCancel: {
              display: cancelStyle.display,
              visibility: cancelStyle.visibility,
              opacity: cancelStyle.opacity,
            },
          },
          pricingDialog: {
            hidden: backdrop?.hidden ?? null,
            geometry: geometry(dialog),
            scroll: dialog
              ? {
                  x: dialog.scrollLeft,
                  y: dialog.scrollTop,
                  scrollHeight: dialog.scrollHeight,
                  clientHeight: dialog.clientHeight,
                }
              : null,
            style: dialogStyle
              ? {
                  display: dialogStyle.display,
                  position: dialogStyle.position,
                  transform: dialogStyle.transform,
                  overflow: dialogStyle.overflow,
                  maxHeight: dialogStyle.maxHeight,
                }
              : null,
          },
          pricingBackdrop: {
            geometry: geometry(backdrop),
            backgroundColor: backdrop ? getComputedStyle(backdrop).backgroundColor : null,
          },
          formState: {
            exists: Boolean(form),
            rateHasValue: rate ? rate.value.length > 0 : null,
            rateRequired: rate?.required ?? null,
            rateValid: rate?.validity.valid ?? null,
            pricingScope: Array.from(document.querySelectorAll("#pricingScope [data-pricing-scope]")).map((button) => ({
              pressed: button.getAttribute("aria-pressed"),
              active: button.classList.contains("active"),
            })),
            list: list
              ? {
                  rowCount: list.querySelectorAll(".pricing-model-row").length,
                  groupCount: list.querySelectorAll(".pricing-harness-group").length,
                  emptyCount: list.querySelectorAll(".empty").length,
                  scrollTop: list.scrollTop,
                  scrollHeight: list.scrollHeight,
                  clientHeight: list.clientHeight,
                  geometry: geometry(list),
                }
              : null,
            pricingMessageHidden: document.querySelector("#pricingMessage")?.hidden ?? null,
          },
        };
      });
    const pricingLayoutState = (state) => ({
      scroll: state.scroll,
      activeElementId: state.activeElementId,
      hovered: state.hovered,
      search: {
        geometry: state.search.geometry,
        style: {
          color: state.search.style.color,
          backgroundColor: state.search.style.backgroundColor,
          backgroundImage: state.search.style.backgroundImage,
          padding: state.search.style.padding,
          border: state.search.style.border,
          borderRadius: state.search.style.borderRadius,
          boxShadow: state.search.style.boxShadow,
          opacity: state.search.style.opacity,
        },
      },
      pricingDialog: state.pricingDialog,
      pricingBackdrop: state.pricingBackdrop,
      formState: state.formState,
    });
    const waitForStablePricingLayout = async () => {
      let previous = await pricingDiagnosticSnapshot();
      let stableFrames = 0;
      for (let frame = 0; frame < 8; frame += 1) {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const current = await pricingDiagnosticSnapshot();
        if (JSON.stringify(pricingLayoutState(current)) === JSON.stringify(pricingLayoutState(previous))) {
          stableFrames += 1;
          if (stableFrames === 2) return { snapshot: current, stableFrames };
        } else {
          stableFrames = 0;
        }
        previous = current;
      }
      assert.fail("计价搜索过滤后的 modal/host 几何未能连续两帧稳定");
    };
    const waitForTwoFrames = () =>
      page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const savePng = (name, png) => writeFileSync(path.join(evidenceDir, name), png);
    const decodePng = (png) =>
      page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        return {
          width: canvas.width,
          height: canvas.height,
          data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
        };
      }, png.toString("base64"));
    const pixelDiff = (left, right, region = null) => {
      if (left.width !== right.width || left.height !== right.height) return { sameSize: false, changedPixels: -1 };
      let changedPixels = 0;
      let changedInRegion = 0;
      for (let pixel = 0; pixel < left.width * left.height; pixel += 1) {
        const x = pixel % left.width;
        const y = Math.floor(pixel / left.width);
        const offset = pixel * 4;
        const changed =
          left.data[offset] !== right.data[offset] ||
          left.data[offset + 1] !== right.data[offset + 1] ||
          left.data[offset + 2] !== right.data[offset + 2] ||
          left.data[offset + 3] !== right.data[offset + 3];
        if (!changed) continue;
        changedPixels += 1;
        if (region && x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height) {
          changedInRegion += 1;
        }
      }
      return { sameSize: true, changedPixels, changedInRegion };
    };
    const pixelDifferenceDetails = (left, right) => {
      if (left.width !== right.width || left.height !== right.height) {
        return {
          sameSize: false,
          boundingBox: {
            x: 0,
            y: 0,
            width: Math.max(left.width, right.width),
            height: Math.max(left.height, right.height),
          },
          pixels: [],
        };
      }
      const pixels = [];
      let minX = left.width;
      let minY = left.height;
      let maxX = -1;
      let maxY = -1;
      for (let pixel = 0; pixel < left.width * left.height; pixel += 1) {
        const offset = pixel * 4;
        const before = left.data.slice(offset, offset + 4);
        const after = right.data.slice(offset, offset + 4);
        if (before.every((channel, index) => channel === after[index])) continue;
        const x = pixel % left.width;
        const y = Math.floor(pixel / left.width);
        pixels.push({ x, y, before, after });
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return {
        sameSize: true,
        boundingBox: pixels.length ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
        pixels,
      };
    };
    const noMarkerOrRule = () =>
      page.evaluate(
        ({ attribute, selector }) => ({
          markerPresent: document.querySelector(selector)?.hasAttribute(attribute) ?? false,
          temporaryRules: Array.from(document.querySelectorAll("style")).filter((style) =>
            style.textContent.includes(attribute),
          ).length,
        }),
        { attribute: marker, selector: "#pricingSearch" },
      );
    const hiddenScreenshots = [];
    const captureDuringHide = async (source, result) => {
      if (!String(source).startsWith("// skinProbe: hide") || !result?.decorationIsolation) return;
      const selector =
        result.decorationIsolation.kind === "calendar-zone-arrow" ? "#calendarZoneSelect" : "#pricingSearch";
      const clientBox = result.decorationIsolation.kind === "search-cancel-button";
      const clip = await clipFor(selector, clientBox);
      const state = clientBox ? await pricingDiagnosticSnapshot() : null;
      hiddenScreenshots.push({
        kind: result.decorationIsolation.kind,
        clip,
        state,
        png: await screenshotWithStyleAttributeGuard(page, { clip }),
      });
    };

    for (const mode of ["light", "dark"]) {
      const pressed = (await page.locator("#themeToggle").getAttribute("aria-pressed")) === "true";
      if (pressed !== (mode === "dark")) await page.locator("#themeToggle").click();
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, mode);
      await page.locator("#updatePricingButton").click();
      await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
      await page.locator("#usdToCnyRate").fill("");
      const searchInput = page.locator("#pricingSearch");
      await searchInput.fill("x");
      await searchInput.scrollIntoViewIfNeeded();
      const { snapshot: searchFilledState, stableFrames } = await waitForStablePricingLayout();
      assert.equal(searchFilledState.search.valueLength, 1, `${mode} reference 建立前 query 保持 x`);
      assert.equal(searchFilledState.formState.list.emptyCount, 0, `${mode} x query 有真实过滤结果`);
      const originalSearchValue = await searchInput.inputValue();
      assert.equal(originalSearchValue, "x");
      const originalPlaceholder = await searchInput.getAttribute("placeholder");
      const originalSearchStyle = await searchInput.getAttribute("style");
      const originalInlineStyles = await searchInput.evaluate((element) => ({
        textFillValue: element.style.getPropertyValue("-webkit-text-fill-color"),
        textFillPriority: element.style.getPropertyPriority("-webkit-text-fill-color"),
        textShadowValue: element.style.getPropertyValue("text-shadow"),
        textShadowPriority: element.style.getPropertyPriority("text-shadow"),
      }));
      await searchInput.evaluate((element) => {
        element.value = "";
        element.placeholder = "";
        element.style.setProperty("-webkit-text-fill-color", "transparent", "important");
        element.style.setProperty("text-shadow", "none", "important");
      });
      await waitForTwoFrames();
      const referenceClip = await clipFor("#pricingSearch", true);
      const referenceState = await pricingDiagnosticSnapshot();
      const referencePng = await screenshotWithStyleAttributeGuard(page, { clip: referenceClip });
      savePng(`${mode}-search-reference.png`, referencePng);
      writeFileSync(
        path.join(evidenceDir, `${mode}-search-reference-diagnostic.json`),
        JSON.stringify(
          {
            browser: evidence.browser,
            mode,
            query: originalSearchValue,
            stableFrames,
            queryState: searchFilledState,
            reference: { clip: referenceClip, state: referenceState },
            referenceLayoutMatchesQuery:
              JSON.stringify(pricingLayoutState(referenceState)) ===
              JSON.stringify(pricingLayoutState(searchFilledState)),
          },
          null,
          2,
        ),
      );
      assert.equal(referenceState.search.valueLength, 0, `${mode} reference 用原生空值移除文字与 clear glyph`);
      assert.equal(referenceState.search.placeholderLength, 0, `${mode} reference 不绘制 placeholder`);
      assert.deepEqual(
        pricingLayoutState(referenceState),
        pricingLayoutState(searchFilledState),
        `${mode} 清空输入值不触发应用过滤，reference 保持 x query 的列表、dialog、host、focus、scroll、hover 与样式`,
      );
      await searchInput.evaluate(
        (element, original) => {
          element.value = original.value;
          if (original.placeholder === null) element.removeAttribute("placeholder");
          else element.setAttribute("placeholder", original.placeholder);
          if (original.style === null) element.removeAttribute("style");
          else element.setAttribute("style", original.style);
        },
        { value: originalSearchValue, placeholder: originalPlaceholder, style: originalSearchStyle },
      );
      await waitForTwoFrames();
      const restoredReferenceState = await pricingDiagnosticSnapshot();
      const restoredInlineStyles = await searchInput.evaluate((element) => ({
        textFillValue: element.style.getPropertyValue("-webkit-text-fill-color"),
        textFillPriority: element.style.getPropertyPriority("-webkit-text-fill-color"),
        textShadowValue: element.style.getPropertyValue("text-shadow"),
        textShadowPriority: element.style.getPropertyPriority("text-shadow"),
      }));
      assert.deepEqual(restoredReferenceState, searchFilledState, `${mode} reference 清理后应用与输入状态逐项恢复`);
      assert.deepEqual(restoredInlineStyles, originalInlineStyles, `${mode} reference 的内联值与 priority 恢复`);

      const searchBefore = await snapshot("#pricingSearch");
      const searchClip = await clipFor("#pricingSearch", true);
      const searchBeforePng = await screenshotWithStyleAttributeGuard(page, { clip: searchClip });
      const searchAfterBaselineStyle = await searchInput.evaluate((element) => ({
        styleAttributePresent: element.hasAttribute("style"),
        styleAttributeValue: element.getAttribute("style"),
      }));
      assert.deepEqual(
        searchAfterBaselineStyle,
        {
          styleAttributePresent: searchBefore.styleAttributePresent,
          styleAttributeValue: searchBefore.styleAttributeValue,
        },
        `${mode} baseline screenshot 不得改变 search 的 style 属性边界`,
      );
      assert.deepEqual(searchClip, referenceClip, `${mode} search/reference 使用同一 client clip`);
      const trackedSearchPage = withInjection(page, captureDuringHide);
      const searchResult = await measure(trackedSearchPage, mode, searchRole);
      const searchHidden = hiddenScreenshots.shift();
      assert.equal(searchHidden?.kind, "search-cancel-button", `${mode} search 隐藏期间留图`);
      const searchRecord = searchResult.records[0];
      assert.equal(searchRecord.result, "pass", `${mode} 正常输入文字应通过：${searchRecord.reason}`);
      const searchEvidence = JSON.parse(searchRecord.evidence);
      const searchIsolation = searchEvidence.nodes[0].decorationIsolation;
      assert.equal(searchIsolation.kind, "search-cancel-button");
      assert.equal(searchIsolation.installed, true);
      assert.equal(searchIsolation.hostStable, true);
      assert.equal(searchIsolation.businessStateUnchanged, true);
      assert.match(searchIsolation.diagnosticLimit, /CSSOM visibility/);
      const searchHiddenPng = searchHidden.png;
      const searchAfter = await snapshot("#pricingSearch");
      assert.deepEqual(searchAfter, searchBefore, `${mode} search 值长度、焦点、几何、材质与 marker 恢复`);
      assert.deepEqual(await noMarkerOrRule(), { markerPresent: false, temporaryRules: 0 });
      assert.deepEqual(searchResult.diagnostics.restoration.inlineRestoreFailures, []);
      assert.deepEqual(searchResult.diagnostics.restoration.styleDifferences, []);
      assert.deepEqual(searchResult.diagnostics.restoration.rectDifferences, []);
      const searchAfterPng = await screenshotWithStyleAttributeGuard(page, {
        clip: await clipFor("#pricingSearch", true),
      });
      const searchFinalDiff = pixelDiff(await decodePng(searchBeforePng), await decodePng(searchAfterPng));
      assert.deepEqual(
        searchFinalDiff,
        { sameSize: true, changedPixels: 0, changedInRegion: 0 },
        `${mode} search 恢复后截图逐像素一致`,
      );
      const referenceDecoded = await decodePng(referencePng);
      const hiddenDecoded = await decodePng(searchHiddenPng);
      const referenceDiff = pixelDiff(referenceDecoded, hiddenDecoded);
      const differenceDetails = pixelDifferenceDetails(referenceDecoded, hiddenDecoded);
      savePng(`${mode}-search-before.png`, searchBeforePng);
      savePng(`${mode}-search-hidden.png`, searchHiddenPng);
      savePng(`${mode}-search-reference.png`, referencePng);
      savePng(`${mode}-search-restored.png`, searchAfterPng);
      writeFileSync(
        path.join(evidenceDir, `${mode}-search-reference-diagnostic.json`),
        JSON.stringify(
          {
            browser: evidence.browser,
            mode,
            query: originalSearchValue,
            stableFrames,
            queryState: searchFilledState,
            reference: { clip: referenceClip, state: referenceState },
            afterReferenceRestore: restoredReferenceState,
            referenceLayoutMatchesQuery:
              JSON.stringify(pricingLayoutState(referenceState)) ===
              JSON.stringify(pricingLayoutState(searchFilledState)),
            hidden: { clip: searchHidden.clip, state: searchHidden.state },
            pixelDiff: referenceDiff,
            boundingBox: differenceDetails.boundingBox,
            differingPixels: differenceDetails.pixels,
          },
          null,
          2,
        ),
      );
      assert.equal(referenceDiff.changedPixels, 0, `${mode} 隐藏文字和清除叉后的 search 应与空白无清除叉参考框一致`);
      const searchDecorationDiff = pixelDiff(await decodePng(searchBeforePng), await decodePng(searchHiddenPng), {
        x: Math.max(0, searchClip.width - 32),
        y: 0,
        width: Math.min(32, searchClip.width),
        height: searchClip.height,
      });
      assert.ok(searchDecorationDiff.changedInRegion > 0, `${mode} 有值 search 尾部原生叉区域应在隐藏时变化`);
      assert.ok(searchResult.captures.some((capture) => capture.kind === "background"));
      const searchBackground = searchResult.captures.find((capture) => capture.kind === "background");
      evidence.samples.push({
        id: `search-${mode}`,
        result: searchRecord.result,
        ratio: searchRecord.ratio,
        threshold: searchRecord.threshold,
        decorationIsolation: searchIsolation,
        backgroundCapture: searchBackground?.clip ?? null,
        hiddenScreenshotClip: searchHidden.clip,
        decorationPixelDiff: searchDecorationDiff,
        emptyReferencePixelDiff: referenceDiff,
        restoredPixelDiff: searchFinalDiff,
        restoration: searchResult.diagnostics.restoration,
      });
      await page.locator("#cancelPricingButton").click();
      await page.waitForFunction(() => document.querySelector("#pricingDialog")?.hidden === true);

      await page.locator("#calendarZoneSelect").scrollIntoViewIfNeeded();
      const zoneBefore = await snapshot("#calendarZoneSelect");
      const zonePng = await screenshotWithStyleAttributeGuard(page, {
        clip: await clipFor("#calendarZoneSelect"),
      });
      const zoneResult = await measure(withInjection(page, captureDuringHide), mode, zoneRole);
      const zoneHidden = hiddenScreenshots.shift();
      assert.equal(zoneHidden?.kind, "calendar-zone-arrow", `${mode} calendar 隐藏期间留图`);
      const zoneRecord = zoneResult.records[0];
      assert.equal(zoneRecord.result, "pass", `${mode} 时区标签正常文字应通过：${zoneRecord.reason}`);
      const zoneEvidence = JSON.parse(zoneRecord.evidence);
      const zoneIsolation = zoneEvidence.nodes[0].decorationIsolation;
      assert.equal(zoneIsolation.kind, "calendar-zone-arrow");
      assert.equal(zoneIsolation.installed, true);
      assert.equal(zoneIsolation.hostStable, true);
      const zoneAfter = await snapshot("#calendarZoneSelect");
      assert.deepEqual(zoneAfter, zoneBefore, `${mode} 时区按钮、箭头内联 priority、几何与表面恢复`);
      assert.deepEqual(zoneResult.diagnostics.restoration.inlineRestoreFailures, []);
      assert.deepEqual(zoneResult.diagnostics.restoration.styleDifferences, []);
      assert.deepEqual(zoneResult.diagnostics.restoration.rectDifferences, []);
      const zoneAfterPng = await screenshotWithStyleAttributeGuard(page, {
        clip: await clipFor("#calendarZoneSelect"),
      });
      const zoneFinalDiff = pixelDiff(await decodePng(zonePng), await decodePng(zoneAfterPng));
      assert.deepEqual(
        zoneFinalDiff,
        { sameSize: true, changedPixels: 0, changedInRegion: 0 },
        `${mode} 箭头恢复后截图逐像素一致`,
      );
      const arrowRegion = {
        x: Math.max(0, Math.floor(zoneBefore.arrow.rect.x - zoneBefore.rect.x)),
        y: Math.max(0, Math.floor(zoneBefore.arrow.rect.y - zoneBefore.rect.y)),
        width: Math.ceil(zoneBefore.arrow.rect.width),
        height: Math.ceil(zoneBefore.arrow.rect.height),
      };
      const arrowDiff = pixelDiff(await decodePng(zonePng), await decodePng(zoneHidden.png), arrowRegion);
      assert.ok(arrowDiff.changedInRegion > 0, `${mode} 隐藏期间箭头区域必须有像素变化`);
      savePng(`${mode}-calendar-before.png`, zonePng);
      savePng(`${mode}-calendar-hidden.png`, zoneHidden.png);
      savePng(`${mode}-calendar-restored.png`, zoneAfterPng);
      evidence.samples.push({
        id: `calendar-${mode}`,
        result: zoneRecord.result,
        ratio: zoneRecord.ratio,
        threshold: zoneRecord.threshold,
        decorationIsolation: zoneIsolation,
        hiddenScreenshotClip: zoneHidden.clip,
        decorationPixelDiff: arrowDiff,
        restoredPixelDiff: zoneFinalDiff,
        restoration: zoneResult.diagnostics.restoration,
      });

      await page.locator("#updatePricingButton").click();
      await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
      await page.locator("#usdToCnyRate").fill("");
      await page.locator("#pricingSearch").fill("x");
      const originalStyle = await page.locator("#pricingSearch").getAttribute("style");
      const lowContrastColor = mode === "light" ? "rgb(255, 255, 255)" : "rgb(27, 34, 41)";
      await page.locator("#pricingSearch").evaluate((element, color) => {
        element.style.setProperty("background-color", color, "important");
        element.style.setProperty("background-image", "none", "important");
        element.style.setProperty("box-shadow", "none", "important");
        element.style.setProperty("color", color, "important");
      }, lowContrastColor);
      const lowContrastResult = await measure(page, mode, searchRole);
      const lowContrastRecord = lowContrastResult.records[0];
      assert.equal(lowContrastRecord.result, "fail", `${mode} 低对比输入文字仍必须失败：${lowContrastRecord.reason}`);
      assert.ok(lowContrastRecord.ratio < lowContrastRecord.threshold);
      await page.locator("#pricingSearch").evaluate((element, style) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }, originalStyle);
      evidence.samples.push({
        id: `search-low-contrast-${mode}`,
        result: lowContrastRecord.result,
        ratio: lowContrastRecord.ratio,
        threshold: lowContrastRecord.threshold,
        decorationIsolation: JSON.parse(lowContrastRecord.evidence).nodes[0].decorationIsolation,
      });
      await page.locator("#cancelPricingButton").click();
      await page.waitForFunction(() => document.querySelector("#pricingDialog")?.hidden === true);
    }

    // DOM 身份失效触发一次整轮重试：旧 search 节点和新节点都不能留下 marker/rule。
    await page.locator("#updatePricingButton").click();
    await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
    await page.locator("#usdToCnyRate").fill("");
    await page.locator("#pricingSearch").fill("x");
    const retryBaselineStyle = await page.locator("#pricingSearch").getAttribute("style");
    let replaced = false;
    let detachedSearchCleanup = null;
    const retryPage = withInjection(page, async (source) => {
      if (replaced || !String(source).startsWith("// skinProbe: scan")) return;
      detachedSearchCleanup = await page.evaluate(
        ({ attribute, baselineStyle }) => {
          const old = document.querySelector("#pricingSearch");
          const clone = document.createElement("input");
          for (const { name, value } of old.attributes) {
            if (name !== attribute && name !== "style") clone.setAttribute(name, value);
          }
          if (baselineStyle !== null) clone.setAttribute("style", baselineStyle);
          clone.value = old.value;
          old.replaceWith(clone);
          clone.focus();
          window.__m52D2b3DetachedSearch = old;
          return null;
        },
        { attribute: marker, baselineStyle: retryBaselineStyle },
      );
      replaced = true;
    });
    const retryResult = await measure(retryPage, "dark", searchRole);
    assert.equal(replaced, true, "重试注入点确实替换了 search 节点");
    const retryRecord = retryResult.records[0];
    assert.equal(
      retryRecord.result,
      "pass",
      `${retryRecord.reason}; ${retryResult.diagnostics.notes.join(" | ")}; ${JSON.stringify(await snapshot("#pricingSearch"))}; ${JSON.stringify(JSON.parse(retryRecord.evidence).nodes?.[0]?.decorationIsolation)}; ${JSON.stringify(JSON.parse(retryRecord.evidence).nodes?.[0]?.bands?.[0]?.worst)}`,
    );
    assert.ok(retryResult.diagnostics.notes.some((note) => note.includes("DOM 样本失效")));
    assert.deepEqual(await noMarkerOrRule(), { markerPresent: false, temporaryRules: 0 });
    detachedSearchCleanup = await page.evaluate(
      (attribute) => ({
        markerPresent: window.__m52D2b3DetachedSearch?.hasAttribute(attribute) ?? false,
        temporaryRules: Array.from(document.querySelectorAll("style")).filter((style) =>
          style.textContent.includes(attribute),
        ).length,
      }),
      marker,
    );
    assert.deepEqual(detachedSearchCleanup, { markerPresent: false, temporaryRules: 0 });
    evidence.recovery.identityRetry = {
      replaced,
      result: retryResult.records[0].result,
      notes: retryResult.diagnostics.notes,
      cleanup: await noMarkerOrRule(),
      detachedCleanup: detachedSearchCleanup,
      restoration: retryResult.diagnostics.restoration,
    };

    // 真实遮挡拒绝仍经正常 restore/verify；扫描异常则由 finally + release 清理。
    const occlusionBefore = await screenshotWithStyleAttributeGuard(page, { fullPage: true });
    const occlusionBeforeState = await snapshot("#pricingSearch");
    let blockerInstalled = false;
    const occlusionPage = {
      async evaluate(source, argument) {
        if (!blockerInstalled && String(source).startsWith("// skinProbe: occlusion-probe")) {
          await page.evaluate(() => {
            const input = document.querySelector("#pricingSearch");
            const rect = input.getBoundingClientRect();
            const blocker = document.createElement("div");
            blocker.id = "m52-d2b3-occlusion";
            Object.assign(blocker.style, {
              position: "fixed",
              left: `${rect.left + rect.width / 2 - 8}px`,
              top: `${rect.top + rect.height / 2 - 8}px`,
              width: "16px",
              height: "16px",
              zIndex: "2147483647",
              background: "transparent",
            });
            document.body.appendChild(blocker);
          });
          blockerInstalled = true;
        }
        return page.evaluate(source, argument);
      },
      screenshot: (options) => page.screenshot(options),
    };
    const occlusionResult = await measure(occlusionPage, "dark", searchRole);
    assert.equal(occlusionResult.records[0].result, "unmeasured", "外部遮挡不得生成可信比值");
    assert.match(occlusionResult.records[0].reason, /(遮挡|宿主及其后代之外的命中)/);
    assert.deepEqual(await noMarkerOrRule(), { markerPresent: false, temporaryRules: 0 });
    await page.locator("#m52-d2b3-occlusion").evaluate((element) => element.remove());
    const occlusionAfter = await screenshotWithStyleAttributeGuard(page, { fullPage: true });
    const occlusionAfterState = await snapshot("#pricingSearch");
    const occlusionFinalDiff = await page.evaluate(
      buildProbeSource("compare-images", occlusionBefore.toString("base64"), occlusionAfter.toString("base64")),
    );
    assert.equal(occlusionFinalDiff.identical, true, "移除测试遮挡层后页面截图必须逐像素恢复");
    assert.deepEqual(occlusionAfterState, occlusionBeforeState, "拒绝遮挡后 search 值、焦点、几何与表面不变");
    savePng("occlusion-restored-before.png", occlusionBefore);
    savePng("occlusion-restored-after.png", occlusionAfter);
    evidence.recovery.occlusion = {
      result: occlusionResult.records[0].result,
      reason: occlusionResult.records[0].reason,
      cleanup: await noMarkerOrRule(),
      pageAfterBlockerRemovalPixelDiff: occlusionFinalDiff,
      duringMeasurementStatePixelDiffIncludesInjectedBlocker: occlusionResult.diagnostics.restoration.statePixelDiff,
      restoration: occlusionResult.diagnostics.restoration,
    };

    const throwingPage = {
      evaluate(source, argument) {
        if (String(source).startsWith("// skinProbe: scan")) throw new Error("D2b3 deliberate scan failure");
        return page.evaluate(source, argument);
      },
      screenshot: (options) => page.screenshot(options),
    };
    const exceptionBeforeState = await snapshot("#pricingSearch");
    const exceptionBeforePng = await screenshotWithStyleAttributeGuard(page, {
      clip: await clipFor("#pricingSearch", true),
    });
    await assert.rejects(measure(throwingPage, "dark", searchRole), /D2b3 deliberate scan failure/);
    assert.deepEqual(await noMarkerOrRule(), { markerPresent: false, temporaryRules: 0 });
    const exceptionAfterState = await snapshot("#pricingSearch");
    const exceptionAfterPng = await screenshotWithStyleAttributeGuard(page, {
      clip: await clipFor("#pricingSearch", true),
    });
    const exceptionPixelDiff = await page.evaluate(
      buildProbeSource("compare-images", exceptionBeforePng.toString("base64"), exceptionAfterPng.toString("base64")),
    );
    assert.equal(exceptionPixelDiff.identical, true, "扫描异常 finally 清理后 search 图像必须逐像素恢复");
    assert.deepEqual(exceptionAfterState, exceptionBeforeState, "扫描异常后 search 值、焦点、几何与材质不变");
    savePng("scan-exception-before.png", exceptionBeforePng);
    savePng("scan-exception-after.png", exceptionAfterPng);
    evidence.recovery.scanException = {
      rejected: true,
      cleanup: await noMarkerOrRule(),
      restoredPixelDiff: exceptionPixelDiff,
    };
    assert.deepEqual(blockedRemoteRequests, [], "真实回归不得请求远程资源");
    writeFileSync(path.join(evidenceDir, "browser-regression.json"), JSON.stringify(evidence, null, 2));
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test("M5.2.C-E1c：真实Edge验证五状态浅深输入目标、适用性与恢复", async () => {
  const browserRuntime = await resolveBrowserRuntime();
  assert.ok(browserRuntime, "E1c 必须使用真实 Edge/Chromium，不得跳过或以 Node 替代");
  const fixture = await createPaletteFixture();
  const pricingSourceUrls = [
    MODEL_PRICES_URL,
    LITELLM_PRICES_URL,
    MIMO_PRICES_URL,
    STEPFUN_PRICES_URL,
    KIMI_PRICES_URL,
    GLM_PRICES_URL,
    USD_CNY_RATE_URL,
  ];
  const pricingFetcherRequests = [];
  let finishPricingResponses;
  let pricingResponsesReleased = false;
  const pricingResponses = new Promise((resolve) => {
    finishPricingResponses = resolve;
  });
  const releasePricingResponses = () => {
    if (pricingResponsesReleased) return;
    pricingResponsesReleased = true;
    finishPricingResponses();
    if (evidence.serverPricing) evidence.serverPricing.releasedAfterBaselineSnapshot = true;
  };
  const pricingFetcher = async (url) => {
    const allowed = pricingSourceUrls.includes(url);
    const request = { url, allowed, fixtureStatus: null, outcome: null };
    pricingFetcherRequests.push(request);
    if (!allowed) {
      request.outcome = "rejected-unknown-url";
      throw new TypeError(`Unexpected pricing URL in E1c offline fixture: ${url}`);
    }
    await pricingResponses;
    request.fixtureStatus = 503;
    request.outcome = "controlled-offline-response";
    return new Response("E1c deterministic offline pricing fixture.", { status: 503 });
  };
  const serverOptions = createPaletteServerOptions(fixture);
  serverOptions.pricingFetcher = pricingFetcher;
  assert.equal(serverOptions.pricingFetcher, pricingFetcher, "E1c server must use the offline pricing hook");
  const server = createUsageServer(serverOptions);
  let browser = null;
  let context = null;
  const blockedRemoteRequests = [];
  const evidenceDir = path.resolve(
    "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m52-c-d8u24-e1c-pricing-fixture/run-01",
    `e1c-${Date.now()}-${process.pid}`,
  );
  mkdirSync(evidenceDir, { recursive: false });
  const evidence = {
    card: "M5.2.C-E1c",
    browser: null,
    roleHash: hashRoleInputs(),
    blockedRemoteRequests,
    serverPricing: {
      fixture: "deterministic offline HTTP 503; measurement-only, no pricing-update claim",
      allowedUrls: pricingSourceUrls,
      requests: pricingFetcherRequests,
      responseStatus: 503,
      releasedAfterBaselineSnapshot: false,
      unknownUrlBehavior: "throw before any fallback fetch",
    },
    measurements: [],
    restorationDiffs: [],
  };
  const evidencePath = path.join(evidenceDir, "browser-regression.json");
  const writeEvidence = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  const syntheticValue = "E1C_SYNTHETIC";

  try {
    const port = await listenOnFreePort(server);
    const origin = `http://127.0.0.1:${port}`;
    const readPricingCatalog = async () => {
      const response = await fetch(`${origin}/api/pricing`);
      assert.equal(response.status, 200, "local pricing catalog must be readable during E1c");
      return response.json();
    };
    const pricingBeforeRefresh = await readPricingCatalog();
    const { chromium, executablePath } = browserRuntime;
    browser = await chromium.launch({ executablePath, headless: true });
    evidence.browser = { version: browser.version(), executablePath, origin };
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin || requestUrl.protocol === "data:") return route.continue();
      blockedRemoteRequests.push(requestUrl.href);
      return route.abort();
    });
    const page = await context.newPage();
    installBrowserColorObserver(page);
    const readPricingInputState = () =>
      page.evaluate(() =>
        ["modelComparisonSearch", "repositoryComparisonSearch", "importPath", "pricingSearch", "usdToCnyRate"].map(
          (id) => {
            const element = document.getElementById(id);
            if (!element) return { id, present: false };
            const style = getComputedStyle(element);
            return {
              id,
              present: true,
              value: element.value,
              placeholder: element.placeholder,
              focused: document.activeElement === element,
              disabled: element.disabled,
              color: style.color,
              backgroundColor: style.backgroundColor,
              opacity: style.opacity,
            };
          },
        ),
      );
    const pricingRefresh = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/pricing/refresh",
      { timeout: 20000 },
    );
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.waitForSelector("#timelineChart", { timeout: 20000 });
    await page.waitForSelector("#modelComparisonSearch", { timeout: 20000 });
    const inputStateBeforeRefresh = await readPricingInputState();
    releasePricingResponses();
    const refreshResponse = await pricingRefresh;
    await refreshResponse.finished();
    const refreshResult = await refreshResponse.json();
    assert.equal(
      refreshResponse.status(),
      200,
      "controlled offline pricing failures must keep the local API responsive",
    );
    assert.ok(pricingFetcherRequests.length > 0, "E1c must exercise the server-side pricingFetcher hook");
    assert.ok(
      pricingFetcherRequests.every((request) => request.allowed && request.fixtureStatus === 503),
      "only fixed source URLs may receive the controlled offline response",
    );
    assert.ok(refreshResult.errors?.length > 0, "the refresh response must report the controlled source failures");
    const pricingAfterRefresh = await readPricingCatalog();
    assert.deepEqual(
      pricingAfterRefresh.models,
      pricingBeforeRefresh.models,
      "failed offline refresh must preserve model prices",
    );
    assert.equal(
      pricingAfterRefresh.usdToCnyRate,
      pricingBeforeRefresh.usdToCnyRate,
      "failed offline refresh must preserve the exchange rate",
    );
    await page.waitForFunction(
      () => {
        const button = document.querySelector("#refreshPricingButton");
        return button && !button.disabled;
      },
      null,
      { timeout: 20000 },
    );
    const inputStateAfterRefresh = await readPricingInputState();
    assert.deepEqual(
      inputStateAfterRefresh,
      inputStateBeforeRefresh,
      "offline refresh must not change measured input state",
    );
    evidence.serverPricing.refreshResult = {
      status: refreshResponse.status(),
      errors: refreshResult.errors,
      requestCount: pricingFetcherRequests.length,
    };
    evidence.serverPricing.catalogStable = {
      modelCount: Object.keys(pricingBeforeRefresh.models).length,
      modelCatalogueUnchanged: true,
      usdToCnyRate: pricingBeforeRefresh.usdToCnyRate,
      inputStateUnchanged: true,
      inputStateBeforeRefresh,
      inputStateAfterRefresh,
    };
    writeEvidence();

    const fullPageScreenshots = [];
    const measurementPage = {
      evaluate: (source, argument) => page.evaluate(source, argument),
      context: () => ({
        newCDPSession: async (target) => {
          assert.equal(target, measurementPage, "CDP target must map to the measurement page");
          return page.context().newCDPSession(page);
        },
      }),
      screenshot: async (options) => {
        const png = await page.screenshot(options);
        if (options?.fullPage === true) fullPageScreenshots.push(png);
        return png;
      },
    };
    const roleById = (id) => {
      const role = ROLE_CATALOG.find((entry) => entry.id === id);
      assert.ok(role, `角色目录缺少 ${id}`);
      return role;
    };
    const waitForStableCanvas = () =>
      page.evaluate(async () => {
        const canvas = document.querySelector("#timelineChart");
        if (!canvas) return { found: false, stable: false, polls: 0 };
        const read = () => canvas.toDataURL();
        let previous = read();
        for (let poll = 1; poll <= 40; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const current = read();
          if (current === previous) return { found: true, stable: true, polls: poll };
          previous = current;
        }
        return { found: true, stable: false, polls: 40 };
      });
    const snapshotPage = () =>
      page.evaluate(() => {
        const ids = [
          "modelComparisonSearch",
          "repositoryComparisonSearch",
          "importPath",
          "pricingSearch",
          "usdToCnyRate",
        ];
        return {
          scroll: {
            windowX: window.scrollX,
            windowY: window.scrollY,
            documentX: document.documentElement.scrollLeft,
            documentY: document.documentElement.scrollTop,
          },
          activeId: document.activeElement?.id ?? null,
          inputs: ids.map((id) => {
            const element = document.getElementById(id);
            if (!element) return { id, present: false };
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              id,
              present: true,
              hasValue: element.value !== "",
              hasPlaceholder: element.placeholder !== "",
              focused: document.activeElement === element,
              opacity: style.opacity,
              inlineOpacity: element.style.getPropertyValue("opacity"),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              markerPresent: element.hasAttribute("data-skin-palette-measurement-decoration"),
            };
          }),
          temporaryRules: Array.from(document.querySelectorAll("style")).filter((style) =>
            style.textContent.includes("data-skin-palette-measurement-decoration"),
          ).length,
        };
      });
    const comparePageImages = (left, right) =>
      page.evaluate(
        async ({ leftBase64, rightBase64 }) => {
          const decode = async (base64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height);
          };
          const before = await decode(leftBase64);
          const after = await decode(rightBase64);
          if (before.width !== after.width || before.height !== after.height) {
            return {
              identical: false,
              dimensionsMatch: false,
              changedPixels: -1,
              boundingBox: {
                x: 0,
                y: 0,
                width: Math.max(before.width, after.width),
                height: Math.max(before.height, after.height),
              },
            };
          }
          let changedPixels = 0;
          let minX = before.width;
          let minY = before.height;
          let maxX = -1;
          let maxY = -1;
          for (let y = 0; y < before.height; y += 1) {
            for (let x = 0; x < before.width; x += 1) {
              const offset = (y * before.width + x) * 4;
              if (
                before.data[offset] === after.data[offset] &&
                before.data[offset + 1] === after.data[offset + 1] &&
                before.data[offset + 2] === after.data[offset + 2] &&
                before.data[offset + 3] === after.data[offset + 3]
              ) {
                continue;
              }
              changedPixels += 1;
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
          }
          return {
            identical: changedPixels === 0,
            dimensionsMatch: true,
            changedPixels,
            boundingBox:
              changedPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
          };
        },
        { leftBase64: left.toString("base64"), rightBase64: right.toString("base64") },
      );
    const safeName = (value) => value.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const runRole = async ({ mode, stateId, roleId, inputIds }) => {
      const stable = await waitForStableCanvas();
      assert.deepEqual(stable, { found: true, stable: true, polls: stable.polls }, "应用 Canvas 先稳定再测量");
      const originalFiles = [];
      for (const id of inputIds) {
        const locator = page.locator(`#${id}`);
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0, `${id} 应可见并有输入区域`);
        const file = `${safeName(`${mode}-${stateId}-${id}`)}-original.png`;
        writeFileSync(path.join(evidenceDir, file), await page.screenshot({ clip: box }));
        originalFiles.push(file);
      }
      const stableGeometry = await page.evaluate(async (ids) => {
        const read = () =>
          JSON.stringify({
            dialog: Array.from(document.querySelectorAll(".dialog-backdrop:not([hidden]) .dialog"), (element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
            inputs: ids.map((id) => {
              const element = document.getElementById(id);
              if (!element) return { id, missing: true };
              const { x, y, width, height } = element.getBoundingClientRect();
              return { id, x, y, width, height };
            }),
          });
        let previous = read();
        let stableFrames = 0;
        for (let frame = 0; frame < 40; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const current = read();
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 2) return { stable: true, frameCount: frame + 1 };
        }
        return { stable: false, frameCount: 40 };
      }, inputIds);
      assert.equal(stableGeometry.stable, true, "目标输入与活动弹窗几何应先跨帧稳定");
      const before = await snapshotPage();
      const screenshotStart = fullPageScreenshots.length;
      const result = await measureBrowserRoles({
        page: measurementPage,
        candidate: null,
        mode,
        stateId,
        roleCatalog: [roleById(roleId)],
        policy: M31_POLICY,
      });
      assert.equal(fullPageScreenshots.length - screenshotStart, 2, "保存测量器内部恢复前后整页截图");
      const fullPageBefore = fullPageScreenshots[screenshotStart];
      const fullPageAfter = fullPageScreenshots[screenshotStart + 1];
      const pixelDiff = await comparePageImages(fullPageBefore, fullPageAfter);
      const after = await snapshotPage();
      const record = result.records[0];
      const recordEvidence = JSON.parse(record.evidence);
      assert.equal(JSON.stringify(record).includes(syntheticValue), false, "测量记录不保存输入文本");
      const stateSnapshot = { before, after };
      const diffFiles = [];
      if (!pixelDiff.identical || result.diagnostics.restoration.statePixelDiff?.identical === false) {
        const stem = safeName(`${mode}-${stateId}-${roleId}`);
        const beforeFile = `${stem}-state-before.png`;
        const afterFile = `${stem}-state-after.png`;
        const diffFile = `${stem}-state-diff.json`;
        writeFileSync(path.join(evidenceDir, beforeFile), fullPageBefore);
        writeFileSync(path.join(evidenceDir, afterFile), fullPageAfter);
        writeFileSync(
          path.join(evidenceDir, diffFile),
          JSON.stringify({ pixelDiff, measurementDiagnostic: result.diagnostics.restoration.statePixelDiff }, null, 2),
        );
        diffFiles.push(beforeFile, afterFile, diffFile);
        evidence.restorationDiffs.push({ mode, stateId, roleId, pixelDiff, files: diffFiles });
      }
      const measurementFiles = [];
      for (const node of recordEvidence.nodes ?? []) {
        const captureIndex = node.bands?.find((band) => typeof band.capture === "number")?.capture;
        const capture = captureIndex === undefined ? null : result.captures[captureIndex];
        if (!capture?.pngBase64) continue;
        const file = `${safeName(`${mode}-${stateId}-${roleId}-${node.identity.id}`)}-measurement.png`;
        writeFileSync(path.join(evidenceDir, file), Buffer.from(capture.pngBase64, "base64"));
        measurementFiles.push(file);
      }
      const measurement = {
        mode,
        stateId,
        roleId,
        selector: recordEvidence.selector ?? null,
        inputOriginals: originalFiles,
        measurementImages: measurementFiles,
        fullPagePixelDiff: pixelDiff,
        restorationDiagnostic: result.diagnostics.restoration,
        stateSnapshot,
        record,
      };
      evidence.measurements.push(measurement);
      writeEvidence();
      assert.deepEqual(after, before, `${mode}/${stateId}/${roleId} 保持滚动、焦点、值布尔、几何和临时规则`);
      assert.deepEqual(result.diagnostics.restoration.inlineRestoreFailures, []);
      assert.deepEqual(result.diagnostics.restoration.styleDifferences, []);
      assert.deepEqual(result.diagnostics.restoration.rectDifferences, []);
      assert.deepEqual(result.diagnostics.restoration.scrollDifferences, []);
      return { record, evidence: recordEvidence, result };
    };
    const assertMeasured = (sample, selector, ids) => {
      assert.equal(sample.evidence.selector, selector);
      assert.deepEqual(
        sample.evidence.nodes.map((node) => node.identity.id).sort(),
        [...ids].sort(),
        "只测量该真实状态目录列出的输入节点",
      );
      assert.ok(["pass", "fail"].includes(sample.record.result), sample.record.reason);
      assert.ok(Number.isFinite(sample.record.ratio));
      assert.equal(sample.evidence.measuredCount, ids.length);
      assert.equal(sample.evidence.unmeasuredCount, 0);
      assert.equal(sample.evidence.notApplicableCount, 0);
      const worst = sample.evidence.worst;
      const background = worst.background.slice(0, 3).map((channel) => channel / 255);
      const recomputed = contrastRatio(
        compositeSrgb(worst.foreground.rgb, worst.foreground.alpha, background),
        background,
      );
      assert.ok(Math.abs(recomputed - sample.record.ratio) < 1e-9, "最差点比值可由记录的前景和背景重算");
    };
    const setTheme = async (mode) => {
      const pressed = (await page.locator("#themeToggle").getAttribute("aria-pressed")) === "true";
      if (pressed !== (mode === "dark")) await page.locator("#themeToggle").click();
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, mode);
    };
    const openPricing = async () => {
      await page.locator("#updatePricingButton").click();
      await page.waitForFunction(() => document.querySelector("#pricingDialog")?.hidden === false);
      await page.waitForFunction(() => document.activeElement?.id === "pricingSearch");
    };

    for (const mode of ["light", "dark"]) {
      await setTheme(mode);
      await page.evaluate(() => window.scrollTo(0, 0));

      const dashboard = await runRole({
        mode,
        stateId: "dashboard-default",
        roleId: "input.placeholder",
        inputIds: ["modelComparisonSearch", "repositoryComparisonSearch"],
      });
      assertMeasured(dashboard, ":is(#modelComparisonSearch, #repositoryComparisonSearch)::placeholder", [
        "modelComparisonSearch",
        "repositoryComparisonSearch",
      ]);
      assert.ok(
        dashboard.evidence.nodes.every((node) => !node.hasValue && node.hasPlaceholder),
        "默认看板两个搜索框均为空且有 placeholder",
      );

      await page.locator("#addImportButton").click();
      await page.waitForFunction(() => document.querySelector("#importDialog")?.hidden === false);
      await page.locator("#importPath").fill(syntheticValue);
      const importValue = await runRole({
        mode,
        stateId: "dialog-import-open",
        roleId: "input.value",
        inputIds: ["importPath"],
      });
      assertMeasured(importValue, "#importPath", ["importPath"]);
      assert.equal(importValue.evidence.nodes[0].hasValue, true);
      assert.notEqual(importValue.evidence.nodes[0].identity.inputType, "checkbox");
      await page.locator("#cancelImportButton").click();
      await page.waitForFunction(() => document.querySelector("#importDialog")?.hidden === true);

      await openPricing();
      const pricingPlaceholder = await runRole({
        mode,
        stateId: "dialog-pricing-open",
        roleId: "input.placeholder",
        inputIds: ["pricingSearch"],
      });
      assertMeasured(pricingPlaceholder, "#pricingSearch::placeholder", ["pricingSearch"]);
      assert.equal(pricingPlaceholder.evidence.nodes[0].hasValue, false);
      assert.equal(pricingPlaceholder.evidence.nodes[0].hasPlaceholder, true);

      await page.locator("#pricingSearch").focus();
      await page.waitForFunction(() => document.activeElement?.matches("#pricingSearch:focus"));
      const focusedPlaceholder = await runRole({
        mode,
        stateId: "input-focus",
        roleId: "input.placeholder",
        inputIds: ["pricingSearch"],
      });
      assertMeasured(focusedPlaceholder, "#pricingSearch::placeholder", ["pricingSearch"]);
      assert.equal(focusedPlaceholder.evidence.nodes[0].hasValue, false);
      assert.equal(focusedPlaceholder.evidence.nodes[0].identity.id, "pricingSearch");

      await page.locator("#pricingSearch").fill(syntheticValue);
      const pricingValue = await runRole({
        mode,
        stateId: "pricing-input-filled",
        roleId: "input.value",
        inputIds: ["pricingSearch", "usdToCnyRate"],
      });
      assertMeasured(pricingValue, "#pricingSearch, #usdToCnyRate", ["pricingSearch", "usdToCnyRate"]);
      assert.ok(
        pricingValue.evidence.nodes.every((node) => node.hasValue),
        "搜索与汇率两个目标均有值",
      );
      assert.equal(
        pricingValue.evidence.nodes.some((node) => node.identity.id === "modelComparisonSearch"),
        false,
      );

      const allPlaceholderNodesNotApplicable = await runRole({
        mode,
        stateId: "input-focus",
        roleId: "input.placeholder",
        inputIds: ["pricingSearch"],
      });
      assert.equal(allPlaceholderNodesNotApplicable.record.result, "unmeasured");
      assert.equal(allPlaceholderNodesNotApplicable.record.ratio, null);
      assert.equal(allPlaceholderNodesNotApplicable.evidence.measuredCount, 0);
      assert.equal(allPlaceholderNodesNotApplicable.evidence.unmeasuredCount, 0);
      assert.equal(allPlaceholderNodesNotApplicable.evidence.notApplicableCount, 1);
      assert.equal(allPlaceholderNodesNotApplicable.evidence.notApplicableNodes[0].identity.id, "pricingSearch");

      const baselinePageState = await snapshotPage();
      const originalSearchStyle = await page.locator("#pricingSearch").getAttribute("style");
      await page
        .locator("#pricingSearch")
        .evaluate((element) => element.style.setProperty("opacity", "0.5", "important"));
      const activeGap = await runRole({
        mode,
        stateId: "pricing-input-filled",
        roleId: "input.value",
        inputIds: ["pricingSearch", "usdToCnyRate"],
      });
      const identityGap = activeGap.evidence.unmeasuredNodes.find((node) => node.identity.id === "pricingSearch");
      assert.ok(identityGap, "活动输入 opacity 不可隔离时必须留下带身份的缺测");
      assert.match(identityGap.reason, /opacity/);
      await page.locator("#pricingSearch").evaluate((element, style) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }, originalSearchStyle);
      assert.deepEqual(await snapshotPage(), baselinePageState, "控制用 opacity 在测量后精确恢复");
      await page.locator("#cancelPricingButton").click();
      await page.waitForFunction(() => document.querySelector("#pricingDialog")?.hidden === true);
      writeEvidence();
    }
    assert.deepEqual(blockedRemoteRequests, [], "E1c 真实验证不得请求远程资源");
    evidence.completed = true;
    writeEvidence();
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    releasePricingResponses();
    try {
      await context?.close();
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
    } finally {
      writeEvidence();
    }
  }
});

test("M5.2.C-E1d：真实Edge深色dashboard在聚光淡入稳定后取整页基准", async () => {
  const browserRuntime = await resolveBrowserRuntime();
  assert.ok(browserRuntime, "E1d 必须使用真实 Edge/Chromium，不得跳过或以 Node 替代");
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  let browser = null;
  let context = null;
  let animationInspection = null;
  const blockedRemoteRequests = [];
  const fullPageScreenshots = [];
  const runId = `dark-dashboard-${new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "")}`;
  const evidenceRoot = path.resolve(
    "docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m52-c-d8u7-restoration/browser/e1d",
  );
  const evidenceDir = path.resolve(evidenceRoot, runId);
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(evidenceDir, { recursive: false });
  const writeEvidence = (result, metadata) => {
    writeFileSync(path.join(evidenceDir, "before.png"), fullPageScreenshots[0]);
    writeFileSync(path.join(evidenceDir, "after.png"), fullPageScreenshots[1]);
    writeFileSync(
      path.join(evidenceDir, "diagnostic.json"),
      JSON.stringify(
        {
          card: "M5.2.C-E1d",
          runId,
          browser: metadata,
          blockedRemoteRequests,
          animationInspection,
          record: result.records[0],
          restoration: result.diagnostics.restoration,
          notes: result.diagnostics.notes,
        },
        null,
        2,
      ),
    );
  };

  try {
    const port = await listenOnFreePort(server);
    const origin = `http://127.0.0.1:${port}`;
    const { chromium, executablePath } = browserRuntime;
    browser = await chromium.launch({ executablePath, headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin || requestUrl.protocol === "data:") return route.continue();
      blockedRemoteRequests.push(requestUrl.href);
      return route.abort();
    });
    const page = await context.newPage();
    installBrowserColorObserver(page);
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.waitForSelector("#timelineChart", { timeout: 20000 });
    await page.waitForSelector("#modelComparisonSearch", { timeout: 20000 });
    if ((await page.locator("#themeToggle").getAttribute("aria-pressed")) !== "true") {
      await page.locator("#themeToggle").click();
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(async () => {
      const canvas = document.querySelector("#timelineChart");
      let previous = canvas?.toDataURL() ?? null;
      for (let poll = 0; poll < 40; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = canvas?.toDataURL() ?? null;
        if (current === previous) return;
        previous = current;
      }
      throw new Error("E1d Canvas did not stabilize within 40 polls");
    });
    for (const id of ["modelComparisonSearch", "repositoryComparisonSearch"]) {
      const locator = page.locator(`#${id}`);
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, `${id} must be visible in the R3-equivalent state`);
      writeFileSync(path.join(evidenceDir, `${id}.png`), await page.screenshot({ clip: box }));
    }
    animationInspection = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".shell [data-spotlight-active]"), (host) => {
        const inspect = (subtree) =>
          host.getAnimations({ subtree }).map((animation) => {
            const effect = animation.effect;
            const target = effect?.target;
            const timing = effect?.getComputedTiming?.();
            return {
              playState: animation.playState,
              transitionProperty: animation.transitionProperty ?? null,
              effectTarget: target?.id || target?.parentElement?.id || target?.constructor?.name || null,
              effectTargetType: target?.constructor?.name ?? null,
              pseudoElement: effect?.pseudoElement ?? null,
              duration: timing?.duration ?? null,
              endTime: timing?.endTime ?? null,
              iterations: timing?.iterations ?? null,
            };
          });
        return {
          hostId: host.id || null,
          opacity: getComputedStyle(host, "::after").opacity,
          subtreeFalse: inspect(false),
          subtreeTrue: inspect(true),
        };
      }),
    );
    const role = ROLE_CATALOG.find((entry) => entry.id === "input.placeholder");
    assert.ok(role?.states.includes("dashboard-default"));
    await page.addStyleTag({
      content: `
        #modelComparisonSearch::placeholder,
        #repositoryComparisonSearch::placeholder {
          color: #232b32 !important;
          opacity: 1 !important;
        }
      `,
    });
    const measurementPage = {
      evaluate: (source, argument) => page.evaluate(source, argument),
      context: () => ({
        newCDPSession: async (target) => {
          assert.equal(target, measurementPage, "CDP target must map to the measurement page");
          return page.context().newCDPSession(page);
        },
      }),
      screenshot: async (options) => {
        const png = await page.screenshot(options);
        if (options?.fullPage === true) fullPageScreenshots.push(png);
        return png;
      },
    };
    const result = await measureBrowserRoles({
      page: measurementPage,
      candidate: null,
      mode: "dark",
      stateId: "dashboard-default",
      roleCatalog: [role],
      policy: M31_POLICY,
    });
    assert.equal(fullPageScreenshots.length, 2, "保存稳定等待后的内部基准/恢复整页截图");
    const metadata = {
      version: browser.version(),
      executablePath,
      origin,
      viewport: { width: 1280, height: 900 },
    };
    writeEvidence(result, metadata);
    assert.deepEqual(blockedRemoteRequests, []);
    assert.equal(result.diagnostics.restoration.spotlightStability.stable, true);
    assert.equal(result.diagnostics.restoration.spotlightStability.before.stable, true);
    assert.equal(result.diagnostics.restoration.spotlightStability.after.stable, true);
    const beforeStability = result.diagnostics.restoration.spotlightStability.before;
    const initialDetailPanel = beforeStability.initial.find((host) => host.id === "detailPanel");
    const settledDetailPanel = beforeStability.settled.find((host) => host.id === "detailPanel");
    const inspectedDetailPanel = animationInspection.find((host) => host.hostId === "detailPanel");
    assert.ok(initialDetailPanel && settledDetailPanel, "稳定诊断应保留detailPanel的过渡前后状态");
    assert.ok(inspectedDetailPanel, "Edge诊断应保留当前detailPanel的getAnimations查询结果");
    assert.deepEqual(inspectedDetailPanel.subtreeFalse, [], "Edge的subtree:false未返回::after过渡");
    assert.ok(
      inspectedDetailPanel.subtreeTrue.some(
        (animation) =>
          animation.playState === "running" &&
          animation.transitionProperty === "opacity" &&
          animation.effectTarget === "detailPanel" &&
          animation.pseudoElement === "::after" &&
          animation.duration === 120 &&
          animation.endTime === 120 &&
          animation.iterations === 1,
      ),
      "Edge的subtree:true应发现detailPanel自身有限::after opacity transition",
    );
    assert.ok(beforeStability.transitionsWaited > 0, "基准探针应等待真实Edge有限::after opacity transition.finished");
    assert.ok(Number(initialDetailPanel.opacity) < 1, "真实基准应从detailPanel聚光淡入中间态开始");
    assert.equal(Number(settledDetailPanel.opacity), 1, "真实基准应等detailPanel ::after恢复到最终opacity");
    assert.ok(beforeStability.frameCount >= 4, "基准探针应跨帧观察opacity变化并确认稳定");
    assert.equal(result.diagnostics.restoration.statePixelDiff?.identical, true, "两个稳定整页基准必须逐像素一致");
    const placeholderRecord = result.records[0];
    assert.equal(placeholderRecord.result, "fail", "主动注入的低对比placeholder必须失败，不得被等待稳定提升为pass");
    assert.ok(Number.isFinite(placeholderRecord.ratio), "低对比placeholder必须给出有限ratio");
    assert.ok(
      placeholderRecord.ratio < placeholderRecord.threshold,
      `低对比placeholder ratio ${placeholderRecord.ratio} 必须小于实际threshold ${placeholderRecord.threshold}`,
    );
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

// --- C2. 真实浏览器：DOM 身份竞态（M8.1 复核 P1 的正式回归） -------------------
//
// 注入时机完全由测试控制（在指定的 skinProbe 源返回之后立刻改 DOM），不引入
// sleep、超时或概率判定。角色选择器换成自备 fixture 的类名，测量机制与生产路径
// 完全一致（同一条 measureBrowserRoles → 页内源链路）。

/** 测量页包装：evaluate 之后把源串交给测试注入点，注入点在页内改完 DOM 才返回。 */
function withInjection(page, inject) {
  return {
    async evaluate(source, argument) {
      const result = await page.evaluate(source, argument);
      await inject(String(source), result);
      return result;
    },
    screenshot: (options) => page.screenshot(options.fullPage ? { ...options, fullPage: false } : options),
  };
}

test("D8u6-F2：withInjection转发 evaluate 参数并保留返回、错误与注入顺序", async () => {
  const source = (value) => value;
  const argument = { marker: "evaluate-argument" };
  const result = { marker: "page-result" };
  const calls = [];
  const page = {
    async evaluate(actualSource, actualArgument) {
      assert.equal(this, page, "delegate 保留 page.evaluate 的 this");
      assert.equal(actualSource, source);
      assert.equal(actualArgument, argument);
      calls.push("evaluate");
      return result;
    },
  };
  const wrapped = withInjection(page, async (actualSource, actualResult) => {
    assert.equal(actualSource, String(source));
    assert.equal(actualResult, result);
    calls.push("inject");
  });

  assert.equal(await wrapped.evaluate(source, argument), result);
  assert.deepEqual(calls, ["evaluate", "inject"], "注入仍在 page.evaluate 完成之后");

  const pageError = new Error("delegate failure");
  let injectedAfterFailure = false;
  const throwingPage = {
    async evaluate(actualSource, actualArgument) {
      assert.equal(this, throwingPage);
      assert.equal(actualSource, source);
      assert.equal(actualArgument, argument);
      throw pageError;
    },
  };
  await assert.rejects(
    withInjection(throwingPage, async () => {
      injectedAfterFailure = true;
    }).evaluate(source, argument),
    (error) => error === pageError,
  );
  assert.equal(injectedAfterFailure, false, "delegate 抛错时不能继续注入");

  const injectionError = new Error("injection failure");
  await assert.rejects(
    withInjection(page, async () => {
      throw injectionError;
    }).evaluate(source, argument),
    (error) => error === injectionError,
  );
});

/** 身份竞态 fixture：白底 #455666 文字（比值 ≈7.56）与 #455666 色块（比值 ≈7.56）。 */
const M32_RACE_STYLE = `
  body { margin: 0; background: #ffffff; }
  .race-target { background: #ffffff; color: #455666; font: 16px Arial; padding: 12px; }
  .race-surface { width: 120px; height: 40px; background: #455666; }
`;
const M32_RACE_TARGETS = [
  '<th class="race-target" id="race-first">First</th>',
  '<th class="race-target" id="race-second">Second</th>',
];
const m32RaceBody = (extra = "") =>
  `<style>${M32_RACE_STYLE}</style><table><thead><tr>${M32_RACE_TARGETS.join("")}</tr></thead></table>` +
  `<div class="race-surface" id="race-surface-0"></div><div class="race-surface" id="race-surface-1"></div>${extra}`;

test("M3.2 返工回归（真实浏览器）：DOM 身份竞态——已测位次/未测位次被换、集合数量变化都判整轮失效", async (t) => {
  const browserRuntime = await resolveBrowserRuntime();
  if (!browserRuntime) {
    t.diagnostic("Playwright/Edge 不可用：身份竞态真实浏览器回归未执行（不得据此判定通过）");
    return;
  }
  const { chromium, executablePath } = browserRuntime;
  const browser = await chromium.launch({ executablePath, headless: true });
  let context = null;
  try {
    context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const headerRole = m32Role("table.comparison-header", { selector: ".race-target" });
    // 借用聚光角色的既有 surface 路径；在测试副本上恢复数值门槛和平涂背景，
    // 避免产品角色已降为装饰后跳过本测试真正要覆盖的测量机制。
    const surfaceRole = m32Role("spotlight.tinted-surface", {
      kind: "graphic",
      selector: ".race-surface",
      threshold: 3,
      required: true,
      background: { kind: "solid", color: { kind: "var", name: "--panel" } },
    });
    const run = (target, role, stateId = "dashboard-default") =>
      measureBrowserRoles({
        page: target,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [role],
        policy: M31_POLICY,
      });
    const evidenceOfRecord = (record) => JSON.parse(record.evidence);
    // 页内测量暂存的私有状态：每次测量后都不该累积（attempts/sessions 全是强引用）
    const stashState = () =>
      page.evaluate(() => {
        const state = window.__skinPaletteMeasurementStash;
        return {
          attempts: state?.attempts.size ?? 0,
          sessions: state?.sessions.size ?? 0,
        };
      });

    await t.test("已测成员被替换且成为真实低对比：整轮失效重测后必须真实 fail（不是恢复到 pass）", async () => {
      await page.setContent(m32RaceBody());
      let replaced = false;
      const injected = withInjection(page, async (source) => {
        if (replaced || !source.startsWith("// skinProbe: verify")) return;
        await page.evaluate(() => {
          const old = document.getElementById("race-first");
          const clone = old.cloneNode(true);
          clone.style.backgroundColor = "#455666"; // 文字 #455666 → 比值 1.0000
          old.replaceWith(clone);
        });
        replaced = true;
      });
      const result = await run(injected, headerRole);
      const record = result.records[0];
      assert.equal(replaced, true, "注入点必须真的触发（替换时机由测试控制）");
      assert.equal(record.result, "fail", "两个 DOM 版本的样本不得混成 pass");
      assert.equal(record.ratio, 1, "重测当前 DOM 的最差样本应为 1.0000");
      assert.ok(
        result.diagnostics.notes.some((note) => note.includes("DOM 样本失效")),
        "替换过程必须写进诊断，不静默重测",
      );
      assert.ok(
        result.captures.some((capture) => capture.sampleStatus === "invalidated-dom-identity"),
        "失效样本的截图必须标记出来",
      );
      // 当前 DOM 重新测量得到同一结论：fail 来自真实低对比，不是竞态伪影
      const fresh = await run(page, headerRole);
      assert.equal(fresh.records[0].result, "fail");
      assert.equal(fresh.records[0].ratio, 1);
      assert.deepEqual(fresh.diagnostics.restoration.inlineRestoreFailures, []);
    });

    await t.test("匹配集合数量变化：整轮失效后按新集合重测，新增节点必须真的被量到", async () => {
      await page.setContent(m32RaceBody());
      let added = false;
      const injected = withInjection(page, async (source) => {
        if (added || !source.startsWith("// skinProbe: verify")) return;
        await page.evaluate(() => {
          const row = document.querySelector(".race-target").parentElement;
          const extra = document.createElement("th");
          extra.className = "race-target";
          extra.id = "race-third";
          extra.textContent = "Third";
          extra.style.backgroundColor = "#455666"; // 新增节点自身低对比
          row.appendChild(extra);
        });
        added = true;
      });
      const result = await run(injected, headerRole);
      const record = result.records[0];
      assert.equal(added, true);
      assert.equal(record.result, "fail", "数量变化必须使整轮失效；新节点的低对比必须被量到");
      assert.equal(record.ratio, 1);
      const evidence = evidenceOfRecord(record);
      assert.equal(evidence.nodes.length, 3, "重测必须覆盖新集合的三个节点");
      assert.ok(
        result.diagnostics.notes.some((note) => note.includes("数量已变化")),
        "数量变化的原因必须留在诊断里",
      );
    });

    await t.test("未测节点被替换同样使整轮失效——保护范围不止已测成员", async () => {
      await page.setContent(
        m32RaceBody().replace(
          '<th class="race-target" id="race-first">First</th>',
          '<th class="race-target" id="race-first" style="display:none">First</th>',
        ),
      );
      await page.evaluate(() => {
        const row = document.querySelector(".race-target").parentElement;
        const extra = document.createElement("th");
        extra.className = "race-target";
        extra.id = "race-third";
        extra.textContent = "Third";
        row.appendChild(extra);
      });
      let replaced = false;
      const injected = withInjection(page, async (source) => {
        if (replaced || !source.startsWith("// skinProbe: verify")) return;
        // 换掉的是**未测**位次（display:none 的那个），它没有被隐藏/恢复过
        await page.evaluate(() => {
          const old = document.getElementById("race-first");
          const clone = old.cloneNode(true);
          clone.id = "race-first-clone";
          old.replaceWith(clone);
        });
        replaced = true;
      });
      const result = await run(injected, headerRole);
      const record = result.records[0];
      assert.equal(replaced, true);
      assert.equal(record.result, "pass", "重测后两个已渲染节点都达标");
      assert.ok(
        result.diagnostics.notes.some((note) => note.includes("第 0 位已换成新节点")),
        "未测位次被换也必须判定整轮失效并说明原因",
      );
      const evidence = evidenceOfRecord(record);
      assert.equal(evidence.notRenderedCount, 1, "未渲染节点单独记账，不参与覆盖判定");
      assert.equal(evidence.nodes.length, 2, "重测只覆盖已渲染的两个节点");
    });

    await t.test("完整 surface 路径：测量→替换→重测→恢复，内联声明与几何都回到原状", async () => {
      await page.setContent(m32RaceBody());
      let replaced = false;
      const injected = withInjection(page, async (source) => {
        if (replaced || !source.startsWith("// skinProbe: verify")) return;
        await page.evaluate(() => {
          const old = document.getElementById("race-surface-0");
          const clone = old.cloneNode(true);
          clone.style.backgroundColor = "#ffffff"; // 自身填充与背后白底同色 → 比值 1.0000
          old.replaceWith(clone);
        });
        replaced = true;
      });
      const result = await run(injected, surfaceRole, "spotlight-on");
      const record = result.records[0];
      assert.equal(replaced, true);
      assert.equal(record.method, "browser-painted-surface");
      assert.equal(record.result, "fail", "重测后自身填充与真实背景同色必须真实 fail");
      assert.equal(record.ratio, 1);
      assert.ok(result.diagnostics.notes.some((note) => note.includes("DOM 样本失效")));
      // 恢复核验：隐藏/恢复没有改动样式、几何与内联声明
      assert.deepEqual(result.diagnostics.restoration.styleDifferences, []);
      assert.deepEqual(result.diagnostics.restoration.rectDifferences, []);
      assert.deepEqual(result.diagnostics.restoration.inlineRestoreFailures, []);
      const leftover = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".race-surface")).map((element) =>
          element.style.getPropertyValue("background-color"),
        ),
      );
      assert.deepEqual(
        leftover,
        ["rgb(255, 255, 255)", ""],
        "被替换节点保留自身内联色，另一个节点的隐藏内联声明已清除",
      );
    });

    // --- 子文字替换（M8.1 复核返工 2 的 P2）：宿主不变、只换 th 里的 button/span ---
    const childBody = () =>
      `<style>${M32_RACE_STYLE}
         .race-child { background: #ffffff; color: #455666; font: 16px Arial; padding: 12px; }
         .race-child button { color: inherit; font: inherit; background: transparent; border: 0; }
       </style><table><thead><tr>` +
      `<th class="race-child" id="race-host"><button><span>First</span></button></th>` +
      `<th class="race-child" id="race-host-2">Second</th>` +
      `</tr></thead></table>`;
    const childRole = m32Role("table.comparison-header", { selector: ".race-child" });

    await t.test("只换子节点（继承隐藏）→ 整轮失效重测后仍是真实 pass，且不留页内暂存", async () => {
      await page.setContent(childBody());
      let rebuilt = false;
      const injected = withInjection(page, async (source) => {
        // 注入点放在背景截图之前：宿主对象不变，只把 button 换成新对象
        if (rebuilt || !source.startsWith("// skinProbe: scan")) return;
        await page.evaluate(() => {
          const host = document.getElementById("race-host");
          const button = host.querySelector("button");
          button.replaceWith(button.cloneNode(true));
        });
        rebuilt = true;
      });
      const result = await run(injected, childRole);
      const record = result.records[0];
      assert.equal(rebuilt, true, "注入点必须真的触发");
      assert.equal(record.result, "pass", "真实对比没有降低，重测后必须通过");
      assert.ok(record.ratio > 7, `白底 #455666 文字实测应约 7.56，实际 ${record.ratio}`);
      assert.ok(
        result.diagnostics.notes.some((note) => note.includes("子节点已换成新节点")),
        "只换子节点也必须判整轮失效并说明原因",
      );
      assert.deepEqual(await stashState(), { attempts: 0, sessions: 0 }, "测量后不得残留页内暂存");
      // 当前 DOM 重新测量得到同一结论
      const fresh = await run(page, childRole);
      assert.equal(fresh.records[0].result, "pass");
      assert.ok(Math.abs(fresh.records[0].ratio - record.ratio) < 1e-9);
    });

    await t.test("子节点自带显式非透明 text fill → 拒绝污染样本记 unmeasured，不得记成 contrast fail", async () => {
      await page.setContent(childBody());
      let injectedFill = false;
      let childState = null;
      const injected = withInjection(page, async (source) => {
        if (injectedFill || !source.startsWith("// skinProbe: scan")) return;
        childState = await page.evaluate(() => {
          const host = document.getElementById("race-host");
          const button = host.querySelector("button");
          const clone = button.cloneNode(true);
          clone.style.webkitTextFillColor = "#455666"; // 自己画字，覆盖宿主继承来的 transparent
          button.replaceWith(clone);
          return {
            sameHost: document.getElementById("race-host") === host,
            hostFill: getComputedStyle(host).webkitTextFillColor,
            childFill: getComputedStyle(clone).webkitTextFillColor,
          };
        });
        injectedFill = true;
      });
      const result = await run(injected, childRole);
      const record = result.records[0];
      assert.equal(injectedFill, true);
      assert.equal(childState.sameHost, true, "宿主对象必须保持不变（只换子节点）");
      assert.equal(childState.hostFill, "rgba(0, 0, 0, 0)", "宿主 computed fill 已透明");
      assert.equal(childState.childFill, "rgb(69, 86, 102)", "新子节点带自己的非透明填充");
      // 白底与文字的真实对比没有降低；1.0000 来自没被隔离的文字像素 → 污染样本
      assert.notEqual(record.result, "fail", "不得把污染样本记成真实 contrast fail");
      assert.equal(record.result, "unmeasured");
      assert.equal(record.ratio, null, "不得给出污染样本的比值");
      assert.match(record.reason, /隐藏后仍检测到文字绘制|连续两次失效/);
      assert.deepEqual(await stashState(), { attempts: 0, sessions: 0 }, "unmeasured 出口同样要收尾");
      assert.deepEqual(result.diagnostics.restoration.inlineRestoreFailures, []);
    });

    // --- 晚期填充（返工 3）：隐藏检查通过之后，同一个对象在截图窗口里重新画字 ---
    //
    // 隐藏样式是在截图之前写的，live probe、背景截图、PNG 解码跨了异步边界。同一个
    // button 对象完全可能在这期间重新拿到显式 text fill——对象身份、数量全不变，只有
    // 隐藏有效性被推翻。两个注入时点各测一次，都用确定性时点，无 sleep、无概率。
    const withLateFill = (when) => {
      let filled = false;
      const applyFill = async () => {
        if (filled) return;
        await page.evaluate(() => {
          const button = document.querySelector("#race-host button");
          button.style.webkitTextFillColor = "#455666"; // 同一个对象，不换节点
        });
        filled = true;
      };
      return {
        async evaluate(source, argument) {
          // "解码期间"：截图已拍完、PNG 正在解码 → 检查必须发生在 decode() 之后
          if (when === "decode" && String(source).startsWith("// skinProbe: scan")) await applyFill();
          return page.evaluate(source, argument);
        },
        async screenshot(options) {
          // "截图前"：约定截图（fullPage）不算，等第一张带 clip 的背景截图之前再改。
          // 此时隐藏检查与 live probe 都已返回，隐藏样式已经写完。
          if (when === "beforeShot" && options.clip) await applyFill();
          return page.screenshot(options.fullPage ? { ...options, fullPage: false } : options);
        },
      };
    };

    for (const when of ["beforeShot", "decode"]) {
      const label = when === "beforeShot" ? "截图前" : "解码期间";
      await t.test(`同一对象在${label}获得显式 text fill → 解码后复核判隔离失效，记 unmeasured 不是 fail`, async () => {
        await page.setContent(childBody());
        const result = await run(withLateFill(when), childRole);
        const record = result.records[0];
        // 对象没换、数量没变，身份核验必须仍然有效——被推翻的是隐藏有效性
        assert.equal(
          result.diagnostics.notes.some((note) => note.includes("DOM 样本失效")),
          false,
          `${label}填充是同一个对象上的样式变化，不该被当成 DOM 身份失效`,
        );
        assert.notEqual(record.result, "fail", "不得把晚期填充造成的污染样本记成真实 contrast fail");
        assert.equal(record.result, "unmeasured", `${label}填充必须拒绝该样本`);
        assert.equal(record.ratio, null, "不得给出污染样本的比值");
        assert.match(record.reason, /像素扫描时/);
        assert.match(record.reason, /隐藏后仍检测到文字绘制/);
        assert.deepEqual(await stashState(), { attempts: 0, sessions: 0 }, "拒绝样本后仍要收尾释放");
        assert.deepEqual(result.diagnostics.restoration.inlineRestoreFailures, [], "恢复核验必须通过");
        // 注入写的内联声明是测试自己加的，测量不该假装是自己设的（宿主必须已还原）
        const hostState = await page.evaluate(() => {
          const host = document.getElementById("race-host");
          return {
            hostFill: getComputedStyle(host).webkitTextFillColor,
            buttonFill: getComputedStyle(host.querySelector("button")).webkitTextFillColor,
          };
        });
        assert.equal(hostState.hostFill, "rgb(69, 86, 102)", "宿主自身的 color 恢复原状");
        assert.equal(hostState.buttonFill, "rgb(69, 86, 102)", "注入的内联填充保留（测量只还原自己写的）");
        // 清掉注入的内联声明，别影响后面的用例
        await page.evaluate(() =>
          document.querySelector("#race-host button").style.removeProperty("-webkit-text-fill-color"),
        );
      });
    }

    await t.test("身份稳定的真实黑色叠加低对比仍然是 fail（新守卫不得误杀真实失败）", async () => {
      await page.setContent(
        `<style>body { margin: 0; background: #ffffff; }
         .race-dark { background: #455666; color: #455666; font: 16px Arial; padding: 12px; }
        </style><table><thead><tr><th class="race-dark" id="dark-first">First</th>` +
          `<th class="race-dark" id="dark-second">Second</th></tr></thead></table>`,
      );
      const darkRole = m32Role("table.comparison-header", { selector: ".race-dark" });
      const result = await run(page, darkRole);
      const record = result.records[0];
      assert.equal(record.result, "fail", "真实低对比必须仍然 fail");
      assert.equal(record.ratio, 1);
      assert.equal(
        result.diagnostics.notes.some((note) => note.includes("DOM 样本失效")),
        false,
        "没有替换就不该有失效重做记录",
      );
      assert.deepEqual(await stashState(), { attempts: 0, sessions: 0 });
    });
  } finally {
    await context?.close();
    await browser.close();
  }
});

// --- D. M3.3 材质、成对身份与最近邻诊断（纯函数，无浏览器） ---

/** 深色十二键：highlight 亮于面板、shadow 沉到近黑，可量出真实的层次剖面。 */
const M33_DARK_TOKENS = Object.freeze({
  pageBackground: "#141A1F",
  panelBackground: "#1B2429",
  panelBorder: "#2E3A41",
  panelHighlight: "#37505A",
  panelShadow: "#080C0F",
  textPrimary: "#E8EEF0",
  textSecondary: "#A7B6BD",
  accent: "#4FC7D9",
  controlBackground: "#1B2429",
  controlBorder: "#2E3A41",
  controlText: "#E8EEF0",
  chartText: "#A7B6BD",
});

const m33Candidate = (overrides = {}) => ({
  id: "cand-a",
  skinId: "chatgpt",
  variant: "a",
  modes: { light: { ...M31_TOKENS }, dark: { ...M33_DARK_TOKENS } },
  ...overrides,
});

/** 第二套皮肤（claude）：暖页、橙强调，与 chatgpt 有可算且各不相同的身份距离。 */
const M33_CLAUDE_LIGHT = Object.freeze({
  pageBackground: "#EDE7D8",
  panelBackground: "#F7F2E4",
  panelBorder: "#CBC1AB",
  panelHighlight: "#FFFDF6",
  panelShadow: "#A99E82",
  textPrimary: "#2A2620",
  textSecondary: "#5B5342",
  accent: "#B4642A",
  controlBackground: "#F7F2E4",
  controlBorder: "#CBC1AB",
  controlText: "#2A2620",
  chartText: "#5B5342",
});

const M33_CLAUDE_DARK = Object.freeze({
  pageBackground: "#0F1216",
  panelBackground: "#171C21",
  panelBorder: "#2A3138",
  panelHighlight: "#3C4650",
  panelShadow: "#05070A",
  textPrimary: "#ECEFF2",
  textSecondary: "#A5AFB8",
  accent: "#F2A03C",
  controlBackground: "#171C21",
  controlBorder: "#2A3138",
  controlText: "#ECEFF2",
  chartText: "#A5AFB8",
});

const m33Claude = () =>
  m33Candidate({
    id: "cand-b",
    skinId: "claude",
    variant: "b",
    modes: { light: { ...M33_CLAUDE_LIGHT }, dark: { ...M33_CLAUDE_DARK } },
  });

/** 平坡配方：五个面全部同色——用来确认阈值真的会响，而不是永远沉默。 */
const M33_FLAT_TOKENS = Object.freeze({
  pageBackground: "#FBF8F2",
  panelBackground: "#FBF8F2",
  panelBorder: "#FBF8F2",
  panelHighlight: "#FBF8F2",
  panelShadow: "#FBF8F2",
  textPrimary: "#23313C",
  textSecondary: "#455666",
  accent: "#FBF8F2",
  controlBackground: "#FBF8F2",
  controlBorder: "#FBF8F2",
  controlText: "#23313C",
  chartText: "#455666",
});

const m33FlatCandidate = {
  id: "cand-flat",
  skinId: "flat",
  modes: { light: { ...M33_FLAT_TOKENS }, dark: { ...M33_FLAT_TOKENS } },
};

/** 与 M3.1 同源：声明值只从 M1.1 派生结果里读，测试不复制任何混色公式。 */
const m33Declaration = (tokens, mode, cssVariable) => {
  const declarations = derivePaletteDeclarationsFromTokens({ ...tokens }, mode);
  const entry = (declarations ?? []).find(([name]) => name === cssVariable);
  if (!entry) throw new Error(`fixture 缺声明：${mode} ${cssVariable}`);
  return entry[1];
};

const m33Lab = (value) => srgbToOklab(parseDeclaredValue(value).rgb);
const m33Distance = (left, right) => okDistance(m33Lab(left), m33Lab(right));
const m33SurfaceVariable = (name) => MATERIAL_SURFACES.find((surface) => surface.name === name).cssVariable;
const m33SampleVariable = (name) => IDENTITY_SAMPLES.find((sample) => sample.name === name).cssVariable;

test("M3.3：材质剖面读 M1.1 真实声明——五表面 L 链、四条相邻距离、高光/阴影 alpha", () => {
  const material = diagnoseMaterial({ candidate: m33Candidate() });
  assert.equal(material.candidateId, "cand-a");
  assert.equal(material.skinId, "chatgpt");
  assert.equal(material.variant, "a");
  assert.equal(material.modes.light.complete, true);
  assert.deepEqual(material.modes.light.missing, []);
  assert.deepEqual(
    material.modes.light.surfaces.map((surface) => surface.name),
    MATERIAL_SURFACES.map((surface) => surface.name),
    "表面顺序即层次链：陶瓷抬升面 → 面板体 → 面板底缘 → 页面 → 凹陷槽",
  );

  const read = (mode, name) => material.modes[mode].surfaces.find((surface) => surface.name === name);
  // 身份面就是原始 token；派生面必须读 M1.1 的派生声明（两者不同才证明没抄 token）
  assert.equal(read("light", "panel").hex, srgbToHex(hexToSrgb(M31_TOKENS.panelBackground)));
  assert.equal(read("light", "page").hex, srgbToHex(hexToSrgb(M31_TOKENS.pageBackground)));
  assert.equal(
    read("light", "top").value,
    m33Declaration(M31_TOKENS, "light", "--ceramic-top"),
    "top 必须等于 M1.1 派生的 --ceramic-top，不得自己再混一次色",
  );
  assert.notEqual(read("light", "top").hex, read("light", "panel").hex, "派生面与面板体不同色");

  const lOf = (mode, name) => read(mode, name).okL;
  assert.ok(
    lOf("light", "top") > lOf("light", "panel") &&
      lOf("light", "panel") > lOf("light", "bottom") &&
      lOf("light", "bottom") > lOf("light", "page") &&
      lOf("light", "page") > lOf("light", "well"),
    "浅色陶瓷：L 沿 top→panel→bottom→page→well 单调下降",
  );
  assert.ok(
    lOf("dark", "top") > lOf("dark", "panel") && lOf("dark", "panel") > lOf("dark", "bottom"),
    "深色陶瓷：抬升面亮于面板体，面板体亮于底缘",
  );
  assert.ok(
    lOf("dark", "well") > lOf("dark", "page") && lOf("dark", "top") > lOf("dark", "well"),
    "深色陶瓷：凹陷槽亮于页面，抬升面亮于凹陷槽",
  );

  const adjacent = material.modes.light.adjacent;
  assert.equal(adjacent.length, 4);
  assert.deepEqual(
    adjacent.map((entry) => `${entry.from}->${entry.to}`),
    ["top->panel", "panel->bottom", "bottom->page", "page->well"],
  );
  for (const entry of adjacent) {
    assert.equal(
      entry.dOk,
      m33Distance(
        m33Declaration(M31_TOKENS, "light", m33SurfaceVariable(entry.from)),
        m33Declaration(M31_TOKENS, "light", m33SurfaceVariable(entry.to)),
      ),
      `${entry.from}->${entry.to} 必须按 100× OKLab 复算一致`,
    );
  }
  assert.equal(
    material.modes.light.topToBottomDOk,
    m33Distance(
      m33Declaration(M31_TOKENS, "light", "--ceramic-top"),
      m33Declaration(M31_TOKENS, "light", "--ceramic-bottom"),
    ),
    "top↔bottom 距离也要逐位对上",
  );

  // 高光/阴影的 alpha 是剖面的一部分（材质公式只决定这两个值）
  assert.equal(material.modes.light.highlight.value, "rgba(255, 255, 255, 0.6)");
  assert.equal(material.modes.light.highlight.alpha, 0.6);
  assert.equal(material.modes.light.highlight.hex, "#FFFFFF");
  assert.equal(material.modes.light.shadow.value, "rgba(201, 194, 178, 0.54)");
  assert.equal(material.modes.light.shadow.alpha, 0.54);
  assert.equal(material.modes.dark.highlight.value, "rgba(55, 80, 90, 0.4)");
  assert.equal(material.modes.dark.highlight.alpha, 0.4);
  assert.equal(material.modes.dark.shadow.value, "rgba(8, 12, 15, 0.72)");
  assert.equal(material.modes.dark.shadow.alpha, 0.72);

  assert.equal(material.modes.dark.flatSurfaceWarning, false, "深色配方层次明显，不该触发平坡提醒");
  // 剖面只出层次数据：不得混进"陶瓷合格"之类的资格字段
  assert.deepEqual(Object.keys(material.modes.light).sort(), [
    "adjacent",
    "complete",
    "flatSurfaceWarning",
    "highlight",
    "missing",
    "shadow",
    "surfaces",
    "topToBottomDOk",
  ]);
});

test("M3.3：flatSurfaceWarning 只按阈值提醒——全同色一定响、深色配方不响、边界两侧确定", () => {
  assert.deepEqual({ ...DIAGNOSTIC_THRESHOLDS }, { flatSurfaceDOk: 2.0, nearNeighborDOk: 3.0 });
  assert.ok(Object.isFrozen(DIAGNOSTIC_THRESHOLDS));

  const flat = diagnoseMaterial({ candidate: m33Candidate(m33FlatCandidate) });
  assert.equal(flat.modes.light.topToBottomDOk, 0, "五个面同色时 top↔bottom 距离真的是 0（不是缺测补 0）");
  assert.equal(flat.modes.dark.topToBottomDOk, 0);
  for (const entry of flat.modes.light.adjacent) assert.equal(entry.dOk, 0);
  assert.deepEqual(flat.flatSurfaceWarnings, ["light", "dark"]);

  const sculpted = diagnoseMaterial({ candidate: m33Candidate() });
  const actual = sculpted.modes.light.topToBottomDOk;
  assert.ok(actual > 0 && actual < DIAGNOSTIC_THRESHOLDS.flatSurfaceDOk, "M31 结构夹具本身偏平，正好落在阈值内");
  assert.deepEqual(sculpted.flatSurfaceWarnings, ["light"]);
  assert.equal(
    diagnoseMaterial({
      candidate: m33Candidate(),
      thresholds: { flatSurfaceDOk: actual - 1e-9, nearNeighborDOk: DIAGNOSTIC_THRESHOLDS.nearNeighborDOk },
    }).modes.light.flatSurfaceWarning,
    false,
    "阈值压到实测值之下就不再提醒（距离已高于阈值）",
  );
  assert.equal(
    diagnoseMaterial({
      candidate: m33Candidate(),
      thresholds: { flatSurfaceDOk: actual + 1e-9, nearNeighborDOk: DIAGNOSTIC_THRESHOLDS.nearNeighborDOk },
    }).modes.light.flatSurfaceWarning,
    true,
    "阈值抬到实测值之上必须提醒——证明它真在比较",
  );
});

test("M3.3：缺一项就是 incomplete——null 不补 0，未缺的部分照算", () => {
  const partialLight = { ...M31_TOKENS };
  delete partialLight.panelShadow;
  delete partialLight.accent;
  const partial = m33Candidate({
    id: "cand-p",
    skinId: "qwen",
    modes: { light: partialLight, dark: { ...M33_DARK_TOKENS } },
  });
  const full = diagnoseMaterial({ candidate: m33Candidate() });
  const light = diagnoseMaterial({ candidate: partial }).modes.light;

  assert.equal(light.complete, false);
  assert.deepEqual(light.missing, ["--ceramic-well", "page→well 相邻距离（--bg / --ceramic-well）", "--ceramic-shade"]);
  const read = (name) => light.surfaces.find((surface) => surface.name === name);
  for (const field of ["value", "hex", "alpha", "okL"]) {
    assert.equal(read("well")[field], null, `well.${field} 缺测必须是 null`);
    assert.notEqual(read("well")[field], 0, "0 会被读成'与参照完全相同'");
  }
  for (const field of ["value", "hex", "alpha"]) {
    assert.equal(light.shadow[field], null, `shadow.${field} 缺测必须是 null`);
    assert.notEqual(light.shadow[field], 0);
  }
  assert.equal(light.adjacent.at(-1).to, "well");
  assert.equal(light.adjacent.at(-1).dOk, null, "page→well 相邻距离缺测，不得补 0");
  for (const entry of light.adjacent.slice(0, 3)) {
    assert.equal(
      entry.dOk,
      full.modes.light.adjacent.find((other) => other.from === entry.from).dOk,
      "没缺的部分必须照算，且与完整配方逐位相同",
    );
  }
  assert.equal(light.topToBottomDOk, full.modes.light.topToBottomDOk, "top↔bottom 仍可测");
  assert.equal(light.flatSurfaceWarning, true, "缺测不压制可算的提醒");
  assert.equal(diagnoseMaterial({ candidate: partial }).modes.dark.complete, true, "深色配方完整，不被浅色缺项拖累");

  const identity = diagnoseIdentity({ candidates: [m33Candidate(), partial] });
  const pair = identity.pairs[0];
  assert.equal(pair.complete, false);
  assert.deepEqual(pair.missing, ["light --blue"]);
  assert.equal(pair.pairMeanDistance, null, "六项不全时成对近似值是 null，不是 0");
  assert.equal(pair.nearNeighborWarning, false, "距离不全时不得下近邻结论");
  assert.equal(pair.distances.find((entry) => entry.mode === "light" && entry.sample === "accent").dOk, null);
  const cell = identity.matrix.light[0];
  assert.equal(cell.complete, false);
  assert.deepEqual(cell.missing, ["--blue"]);
  assert.equal(cell.distances.accent, null);
  assert.deepEqual(identity.incomplete, [{ left: "cand-a", right: "cand-p", missing: ["light --blue"] }]);
  assert.equal(identity.nearest[0].neighborId, null, "没有可比较的跨皮肤候选时最近邻是 null，不是硬挑一个");
  assert.match(identity.nearest[0].incompleteReason, /没有可比较/);
});

test("M3.3：距离单位统一且交换对称——六项与矩阵逐位复算，左右互换数字不变", () => {
  const chatgpt = m33Candidate();
  const claude = m33Claude();
  const sameSkin = m33Candidate({ id: "cand-c", variant: "b" });
  const byId = new Map([
    ["cand-a", { light: M31_TOKENS, dark: M33_DARK_TOKENS }],
    ["cand-b", { light: M33_CLAUDE_LIGHT, dark: M33_CLAUDE_DARK }],
    ["cand-c", { light: M31_TOKENS, dark: M33_DARK_TOKENS }],
  ]);
  const forward = diagnoseIdentity({ candidates: [chatgpt, claude, sameSkin] });
  const pair = forward.pairs[0];
  assert.equal(pair.distances.length, 6, "浅深 × page/panel/accent 共六项");
  for (const entry of pair.distances) {
    assert.equal(
      entry.dOk,
      m33Distance(
        m33Declaration(byId.get("cand-a")[entry.mode], entry.mode, m33SampleVariable(entry.sample)),
        m33Declaration(byId.get("cand-b")[entry.mode], entry.mode, m33SampleVariable(entry.sample)),
      ),
      `${entry.mode}.${entry.sample} 必须按 100× OKLab 复算一致（换成原始 OKLab 会差 100 倍）`,
    );
  }
  assert.equal(forward.matrix.light.length, 3, "三候选中浅色矩阵有三格（上三角）");
  for (const cell of forward.matrix.light) {
    for (const name of IDENTITY_SAMPLES.map((sample) => sample.name)) {
      assert.equal(
        cell.distances[name],
        m33Distance(
          m33Declaration(byId.get(cell.left).light, "light", m33SampleVariable(name)),
          m33Declaration(byId.get(cell.right).light, "light", m33SampleVariable(name)),
        ),
        `矩阵格 ${cell.left}/${cell.right} 的 ${name} 与六项同公式`,
      );
    }
  }
  const lightCell = forward.matrix.light.find((cell) => cell.left === "cand-a" && cell.right === "cand-b");
  assert.equal(
    lightCell.distances.accent,
    pair.distances.find((entry) => entry.mode === "light" && entry.sample === "accent").dOk,
  );

  const swapped = diagnoseIdentity({ candidates: [claude, chatgpt] });
  const swappedPair = swapped.pairs[0];
  assert.equal(swappedPair.left, "cand-b");
  assert.equal(swappedPair.right, "cand-a");
  assert.deepEqual(swappedPair.distances, pair.distances, "左右互换后六项距离逐位相同");
  assert.equal(swappedPair.pairMeanDistance, pair.pairMeanDistance, "成对近似值也逐位相同");
  assert.equal(swappedPair.nearNeighborWarning, pair.nearNeighborWarning);
  assert.deepEqual(swapped.matrix.light[0].distances, lightCell.distances, "矩阵格同样对称");
});

test("M3.3：pairMeanDistance 就是六项距离的算术平均——全精度，不四舍五入", () => {
  const pair = diagnoseIdentity({ candidates: [m33Candidate(), m33Claude()] }).pairs[0];
  const mean = pair.distances.reduce((sum, entry) => sum + entry.dOk, 0) / pair.distances.length;
  assert.equal(pair.pairMeanDistance, mean);
  assert.ok(Number.isFinite(pair.pairMeanDistance));
  assert.equal(pair.pairMeanDistance, 9.679630463849708, "固定数值：换成中位数/几何平均会立刻被发现");
  assert.deepEqual(
    pair.distances.map((entry) => Number(entry.dOk.toFixed(4))),
    [3.1941, 2.1446, 22.1377, 3.3466, 3.0755, 24.1792],
  );
});

test("M3.3：nearNeighborWarning 只在跨皮肤且六项都低于阈值时提醒", () => {
  const chatgpt = m33Candidate();
  const claude = m33Claude();
  const sameSkin = m33Candidate({ id: "cand-c", variant: "b" });
  const otherSkinClone = m33Candidate({ id: "cand-x", skinId: "grok" });

  const same = diagnoseIdentity({ candidates: [chatgpt, sameSkin] }).pairs[0];
  assert.equal(same.crossSkin, false);
  assert.equal(same.pairMeanDistance, 0, "同皮肤变体本就应该像：完全相同不是问题");
  assert.equal(same.nearNeighborWarning, false, "同皮肤之间不提醒——否则 a/b/c 变体互相打架");

  const clone = diagnoseIdentity({ candidates: [chatgpt, otherSkinClone] }).pairs[0];
  assert.equal(clone.crossSkin, true);
  assert.equal(clone.pairMeanDistance, 0);
  assert.equal(clone.nearNeighborWarning, true, "两款不同皮肤六项全 0 才该提醒");

  const distinct = diagnoseIdentity({ candidates: [chatgpt, claude] }).pairs[0];
  assert.equal(distinct.nearNeighborWarning, false, "有明显距离就不提醒");

  const limit = Math.max(...distinct.distances.map((entry) => entry.dOk));
  assert.equal(
    diagnoseIdentity({
      candidates: [chatgpt, claude],
      thresholds: { flatSurfaceDOk: DIAGNOSTIC_THRESHOLDS.flatSurfaceDOk, nearNeighborDOk: limit + 1e-9 },
    }).pairs[0].nearNeighborWarning,
    true,
  );
  assert.equal(
    diagnoseIdentity({
      candidates: [chatgpt, claude],
      thresholds: { flatSurfaceDOk: DIAGNOSTIC_THRESHOLDS.flatSurfaceDOk, nearNeighborDOk: limit - 1e-9 },
    }).pairs[0].nearNeighborWarning,
    false,
  );
});

test("M3.3：最近邻只认其他皮肤，并列按输入先序，没有可比对象时是 null", () => {
  const chatgpt = m33Candidate();
  const claude = m33Claude();
  const sameSkin = m33Candidate({ id: "cand-c", variant: "b" });
  const nearest = diagnoseIdentity({ candidates: [chatgpt, claude, sameSkin] }).nearest;
  assert.deepEqual(
    nearest.map((entry) => [entry.candidateId, entry.neighborId, entry.neighborSkinId]),
    [
      ["cand-a", "cand-b", "claude"],
      ["cand-b", "cand-a", "chatgpt"],
      ["cand-c", "cand-b", "claude"],
    ],
  );
  assert.equal(nearest[0].pairMeanDistance, 9.679630463849708);
  assert.deepEqual(
    nearest[0].distances,
    diagnoseIdentity({ candidates: [chatgpt, claude, sameSkin] }).pairs.find(
      (pair) => pair.left === "cand-a" && pair.right === "cand-b",
    ).distances,
    "最近邻条目自己带六项距离（同一引用，不是副本），读的人不必回 pairs 里翻",
  );
  assert.equal(nearest[0].distances.length, 6);

  const grok = m33Candidate({ id: "cand-x", skinId: "grok" });
  const qwen = m33Candidate({ id: "cand-y", skinId: "qwen" });
  const tied = diagnoseIdentity({ candidates: [chatgpt, grok, qwen] }).nearest[0];
  assert.equal(tied.neighborId, "cand-x", "并列按输入先序，结果必须可复现");
  assert.equal(tied.neighborSkinId, "grok");
  assert.equal(tied.pairMeanDistance, 0);

  const alone = diagnoseIdentity({ candidates: [chatgpt] }).nearest[0];
  assert.equal(alone.neighborId, null);
  assert.equal(alone.neighborSkinId, null);
  assert.equal(alone.pairMeanDistance, null, "没有可比对象时是 null，不补 0（0 会被读成'有一款一模一样的'）");
  assert.match(alone.incompleteReason, /没有可比较/);
  assert.equal(
    diagnoseIdentity({ candidates: [chatgpt, sameSkin] }).nearest[0].neighborId,
    null,
    "只有同皮肤候选时也不挑",
  );
});

test("M3.3：模块纯度与数据不可变——无 I/O、无 DOM、无随机无时间，输入不改、输出深冻", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/diagnostics.mjs", import.meta.url), "utf8");
  assert.deepEqual(
    [...source.matchAll(/^import .*;$/gm)].map((match) => match[0]),
    [
      'import { MODES } from "./contracts.mjs";',
      'import { okDistance, srgbToHex, srgbToOklab } from "./color-math.mjs";',
      'import { parseDeclaredValue } from "./evaluate.mjs";',
      'import { derivePaletteDeclarationsFromTokens } from "../../public/skins.js";',
    ],
    "只依赖 M0/M1/官方 skins 模块：解析器与混色公式都只有一份",
  );
  for (const banned of [
    "document",
    "window",
    "Math.random",
    "Date.now",
    "process.",
    "readFileSync",
    "writeFileSync",
    "fetch(",
  ]) {
    assert.equal(source.includes(banned), false, `不得出现 ${banned}`);
  }

  const candidates = [m33Candidate(), m33Claude()];
  const before = canonicalJson(candidates);
  const result = diagnoseCandidates({ candidates });
  diagnoseMaterial({ candidate: candidates[0] });
  diagnoseIdentity({ candidates });
  assert.equal(canonicalJson(candidates), before, "诊断不得改动输入候选（含派生路径）");
  for (const frozen of [
    result,
    result.material,
    result.material[0],
    result.material[0].modes,
    result.material[0].modes.light,
    result.material[0].modes.light.surfaces,
    result.material[0].modes.light.surfaces[0],
    result.material[0].modes.light.adjacent[0],
    result.material[0].modes.light.highlight,
    result.identity,
    result.identity.pairs,
    result.identity.pairs[0],
    result.identity.pairs[0].distances,
    result.identity.pairs[0].distances[0],
    result.identity.matrix.light,
    result.identity.matrix.light[0],
    result.identity.matrix.light[0].distances,
    result.identity.nearest,
    result.identity.nearest[0],
  ]) {
    assert.ok(Object.isFrozen(frozen), "输出树必须深冻");
  }
  assert.throws(() => {
    result.material[0].candidateId = "tampered";
  }, TypeError);
});

test("M3.3：诊断树不携带任何阅读判定——材质/差异数据再高也翻不动文字失败", () => {
  const result = diagnoseCandidates({
    candidates: [m33Candidate(), m33Claude(), m33Candidate({ id: "cand-c", variant: "b" })],
  });
  assert.deepEqual(Object.keys(result), ["material", "identity"], "顶层只有两项数据，没有判定分支");
  assert.deepEqual(assertDiagnosticsCarryNoVerdict(result), []);
  assert.equal(typeof result.material[0].flatSurfaceWarnings, "object");
  assert.equal(typeof result.identity.pairs[0].nearNeighborWarning, "boolean");

  const flatA = m33Candidate(m33FlatCandidate);
  const flatB = m33Candidate({
    id: "cand-flat-b",
    skinId: "flat-b",
    modes: { light: { ...M33_FLAT_TOKENS }, dark: { ...M33_FLAT_TOKENS } },
  });
  const worst = diagnoseCandidates({ candidates: [flatA, flatB] });
  assert.deepEqual(worst.material[0].flatSurfaceWarnings, ["light", "dark"]);
  assert.equal(worst.identity.pairs[0].nearNeighborWarning, true);
  assert.equal(worst.identity.pairs[0].pairMeanDistance, 0);
  assert.deepEqual(
    assertDiagnosticsCarryNoVerdict(worst),
    [],
    "连'全平坡 + 两款皮肤一模一样'的诊断树里也不得出现判定键",
  );
});

test("M3.3：输入校验——非数组、缺字段、重复 id、坏阈值都直接抛 TypeError", () => {
  assert.throws(() => diagnoseMaterial(), TypeError);
  assert.throws(() => diagnoseMaterial({ candidate: null }), TypeError);
  assert.throws(() => diagnoseMaterial({ candidate: { id: "x" } }), TypeError);
  assert.throws(() => diagnoseMaterial({ candidate: { id: "x", skinId: "s" } }), TypeError, /modes/);
  const missingDark = m33Candidate();
  missingDark.modes = { light: { ...M31_TOKENS } };
  assert.throws(() => diagnoseMaterial({ candidate: missingDark }), TypeError, /dark/);
  assert.throws(() => diagnoseIdentity(), TypeError);
  assert.throws(() => diagnoseIdentity({ candidates: "cand-a" }), TypeError);
  assert.throws(() => diagnoseIdentity({ candidates: [m33Candidate(), m33Candidate()] }), TypeError, /重复/);
  for (const bad of [0, -1, Number.NaN, "2.0", null]) {
    assert.throws(
      () => diagnoseMaterial({ candidate: m33Candidate(), thresholds: { flatSurfaceDOk: bad, nearNeighborDOk: 3 } }),
      TypeError,
    );
    assert.throws(
      () =>
        diagnoseCandidates({ candidates: [m33Candidate()], thresholds: { flatSurfaceDOk: 2, nearNeighborDOk: bad } }),
      TypeError,
    );
  }
  assert.throws(
    () => diagnoseMaterial({ candidate: m33Candidate(), thresholds: { flatSurfaceDOk: 2 } }),
    TypeError,
    "两个阈值要么都给，要么都不给",
  );
});

/* ==================== M3.4 门禁、视觉初筛与证据过期 ==================== */

const M34_PROFILE = Object.freeze({
  identityHex: "#4F4971",
  surfaceH: 268,
  surfaceC: 0.028,
  pageL: { light: 0.93, dark: 0.17 },
  accentC: 0.1,
});

const m34Candidate = (overrides = {}) => {
  const base = {
    schemaVersion: 1,
    skinId: "chatgpt",
    variant: "a",
    profileVersion: 1,
    profileSnapshot: M34_PROFILE,
    profileHash: sha256Canonical(M34_PROFILE),
    policyHash: sha256Canonical(M31_POLICY),
    derivationHash: "a".repeat(64),
    seed: "skin-palette-quality",
    style: { title: "测试配方", rationale: "测试", identitySource: "#4F4971" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: { ...M31_TOKENS }, dark: { ...M33_DARK_TOKENS } },
  };
  const merged = { ...base, ...overrides };
  const candidateHash = hashCandidate(merged);
  const candidate = {
    ...merged,
    id: `${merged.skinId}-${merged.variant}-${candidateHash.slice(0, 12)}`,
    candidateHash,
  };
  const check = validateCandidate(candidate);
  assert.ok(check.valid, `M3.4 候选必须过 M0 契约：${check.errors[0]?.message ?? "unknown"}`);
  return candidate;
};

/** 出处齐全的 run：候选总集、证据产出时的输入/源文件摘要、fixture 版本一样不缺。 */
const m34Run = (candidate, overrides = {}) => {
  const inputHashes = {
    profiles: sha256Canonical({ chatgpt: M34_PROFILE }),
    policy: sha256Canonical(M31_POLICY),
    roles: hashRoleInputs(),
    derivation: candidate.derivationHash,
  };
  // 源文件摘要随手造的假摘要即可：门禁只比"证据产出时 vs 当前"两份映射，
  // 从不实测磁盘内容。覆盖面按门禁依赖清单（REQUIRED_SOURCE_FILES）逐项给全。
  const sourceHashes = Object.fromEntries(
    REQUIRED_SOURCE_FILES.map((file) => [file, sha256Canonical({ source: file })]),
  );
  const fixture = { version: M31_POLICY.versions.fixture };
  const candidateSet = { inputHashes, candidates: [candidate] };
  return {
    policy: M31_POLICY,
    inputHashes,
    recordedInputHashes: { ...inputHashes },
    sourceHashes: { ...sourceHashes },
    recordedSourceHashes: { ...sourceHashes },
    fixture,
    recordedFixture: { ...fixture },
    candidateSet,
    candidateSetHash: hashCandidateSet(candidateSet),
    ...overrides,
  };
};

const m34Visual = ({ verdict = "accept", items, by = "proxy", ...rest } = {}) => ({
  reviewer: "reviewer-m34",
  by,
  verdict,
  notes: "逐项看过原尺寸截图",
  items:
    items ??
    VISUAL_REVIEW_ITEMS.map((item) => ({
      id: item.id,
      verdict,
      notes: `看过 ${item.label}`,
      screenshots: ["shots/light-dashboard.png"],
    })),
  screenshots: ["shots/light-dashboard.png"],
  ...rest,
});

/** 全部必要 (mode, role, state)：readiness=ready 的唯一充分覆盖集。 */
const m34RequiredPairs = () => {
  const pairs = [];
  for (const mode of MODES) {
    for (const role of ROLE_CATALOG) {
      if (role.required !== true) continue;
      for (const stateId of role.states) pairs.push({ mode, roleId: role.id, stateId, threshold: role.threshold });
    }
  }
  return pairs;
};

const m34Record = (candidateId, pair, overrides = {}) => ({
  candidateId,
  mode: pair.mode,
  roleId: pair.roleId,
  stateId: pair.stateId,
  result: "pass",
  ratio: pair.threshold * 1.5,
  threshold: pair.threshold,
  method: "browser-text-pixels",
  evidence: JSON.stringify({ source: "m34-synthetic" }),
  reason: "",
  ...overrides,
});

const m34Cover = (candidate, pick) =>
  m34RequiredPairs().map((pair, index) => m34Record(candidate.id, pair, pick ? pick(pair, index) : undefined));

const m34Assess = ({ candidate, run, browserChecks, fastChecks = null, visualReview = m34Visual() }) =>
  assessCandidate({ candidate, fastChecks, browserChecks, visualReview, run });

/** 高饱和霓虹配方：与 chatgpt 的身份/材质距离很大，用来证明距离抵消不了文字失败。 */
const M34_NEON_TOKENS = Object.freeze({
  pageBackground: "#12060F",
  panelBackground: "#2A0A22",
  panelBorder: "#5C1140",
  panelHighlight: "#FF3EA5",
  panelShadow: "#050208",
  textPrimary: "#FFE8F6",
  textSecondary: "#F3B9DC",
  accent: "#FF2E93",
  controlBackground: "#2A0A22",
  controlBorder: "#5C1140",
  controlText: "#FFE8F6",
  chartText: "#F3B9DC",
});

test("M3.4：全部必要 (mode, role, state) 有实测通过 + 代理初筛接受 → ready，缺口只剩装饰角色", () => {
  const candidate = m34Candidate();
  const result = m34Assess({ candidate, run: m34Run(candidate), browserChecks: m34Cover(candidate) });
  assert.equal(result.readiness, "ready");
  assert.equal(result.failures.length, 0);
  assert.equal(result.unmeasured.length, 0);
  assert.equal(result.diagnostics.gate.blockers.length, 0);
  assert.equal(result.diagnostics.gate.machineOnly, true);
  const coverage = result.diagnostics.coverage;
  assert.equal(coverage.verdictCounts.pass, m34RequiredPairs().length);
  assert.equal(coverage.verdictCounts.missing, coverage.expectedPairs - m34RequiredPairs().length);
  assert.equal(coverage.gaps.length, 0);
  assert.equal(coverage.provisional.length, 0);
  assert.ok(coverage.uncoveredDecorative.length > 0, "装饰/字标角色缺记录只单独记账，不阻塞 ready");
  assert.ok(
    !m34RequiredPairs().some((pair) => pair.roleId === "logotype.agent-usage"),
    "字标只留视觉结论（visual-review 的 logotype-legible），不算成普通正文 PASS",
  );
  assert.equal(validateAssessment(result).valid, true);
});

test("M3.4：技术失败就是 rejected——材质与身份距离再高也不抵消，诊断树也不夹带判定", () => {
  const candidate = m34Candidate();
  const neon = m34Candidate({
    skinId: "muse",
    variant: "b",
    modes: { light: { ...M34_NEON_TOKENS }, dark: { ...M34_NEON_TOKENS } },
  });
  const set = { inputHashes: m34Run(candidate).inputHashes, candidates: [candidate, neon] };
  const run = m34Run(candidate, { candidateSet: set, candidateSetHash: hashCandidateSet(set) });
  const failing = m34Cover(candidate, (pair) =>
    pair.roleId === "panel.metric-value" && pair.mode === "dark"
      ? { result: "fail", ratio: pair.stateId === "dashboard-default" ? 2.25 : 2.5 }
      : undefined,
  );
  const result = m34Assess({ candidate, run, browserChecks: failing, visualReview: m34Visual({ by: "user" }) });
  assert.equal(result.readiness, "rejected");
  assert.equal(result.failures.length, 2);
  assert.deepEqual(
    result.failures
      .map(({ mode, stateId, roleId, ratio }) => ({ mode, stateId, roleId, ratio }))
      .sort((left, right) => left.stateId.localeCompare(right.stateId)),
    [
      { mode: "dark", stateId: "dashboard-default", roleId: "panel.metric-value", ratio: 2.25 },
      { mode: "dark", stateId: "spotlight-metric-label", roleId: "panel.metric-value", ratio: 2.5 },
    ],
  );
  assert.equal(result.diagnostics.gate.failureCounts.measured, 2);
  assert.equal(result.diagnostics.gate.failureCounts.approximate, 0);
  assert.ok(result.diagnostics.identity.pairs.length > 0);
  assert.ok(
    result.diagnostics.identity.pairs[0].pairMeanDistance > DIAGNOSTIC_THRESHOLDS.nearNeighborDOk,
    "该样例的距离必须真的高于阈值，否则证明不了“高差异也没用”",
  );
  assert.equal(result.diagnostics.material.length, 2);
  assert.deepEqual(
    assertDiagnosticsCarryNoVerdict({
      material: result.diagnostics.material,
      identity: result.diagnostics.identity,
    }),
    [],
  );
});

test("M3.4：缺一个状态就是 incomplete——缺口逐条点名 mode/role/state，缺失不补成通过", () => {
  const candidate = m34Candidate();
  const cover = m34Cover(candidate).filter(
    (record) => !(record.roleId === "input.placeholder" && record.stateId === "input-focus"),
  );
  const result = m34Assess({ candidate, run: m34Run(candidate), browserChecks: cover });
  assert.equal(result.readiness, "incomplete");
  const coverage = result.diagnostics.coverage;
  const decorativeMissing = coverage.expectedPairs - m34RequiredPairs().length;
  assert.equal(coverage.verdictCounts.missing, decorativeMissing + 2, "装饰角色本就缺记录，另外浅深各缺一条");
  assert.equal(coverage.gaps.length, 2);
  const gap = result.diagnostics.coverage.gaps.find(
    (item) => item.roleId === "input.placeholder" && item.stateId === "input-focus" && item.mode === "light",
  );
  assert.ok(gap, "缺口必须点名到具体 (mode, role, state)");
  assert.match(gap.reason, /没有任何测量记录/);
  assert.ok(
    result.diagnostics.gate.blockers.some((text) => text.includes("input.placeholder") && text.includes("input-focus")),
    "blockers 必须让读者知道缺的是哪一条",
  );
});

test("M3.4：本状态缺测被与状态无关的记录覆盖也不算测过——M0 一律 incomplete", () => {
  // 与状态无关的覆盖只允许来自 fast（声明色与状态无关）；浏览器记录一律按状态记账
  const declaredEntry = {
    roleId: "table.comparison-cell",
    status: "pass",
    ratio: 6.75,
    threshold: 4.5,
    method: "solid",
  };
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const declared = {
    light: { entries: [declaredEntry], summary: {} },
    dark: { entries: [declaredEntry], summary: {} },
  };
  const cover = m34Cover(candidate).filter((record) => record.roleId !== "table.comparison-cell");
  const gap = {
    ...m34Record(candidate.id, {
      mode: "light",
      roleId: "table.comparison-cell",
      stateId: "dense-data",
      threshold: 4.5,
    }),
    result: "unmeasured",
    ratio: null,
    reason: "该状态未渲染，无法取样",
  };
  const result = m34Assess({ candidate, run, browserChecks: [...cover, gap], fastChecks: declared });
  assert.equal(result.readiness, "incomplete", "有缺测记录就必须 incomplete，覆盖判读不能替它结案");
  assert.equal(result.unmeasured.length, 1);
  assert.equal(result.diagnostics.coverage.verdictCounts.pass, m34RequiredPairs().length);
  assert.ok(result.diagnostics.gate.blockers.some((text) => text.includes("缺测记录")));
});

test("M3.4：快速近似只作 provisional——不单独 ready，method 带尾缀且理由写明待浏览器确认", () => {
  const candidate = m34Candidate();
  const entries = [
    {
      roleId: "page.body-text",
      status: "pass",
      ratio: 6.2,
      threshold: 4.5,
      method: "gradient-samples",
      approximate: true,
    },
    {
      roleId: "panel.metric-value",
      status: "browser-required",
      threshold: 4.5,
      method: "layered",
      methodDetail: "叠加层",
    },
  ];
  const result = m34Assess({
    candidate,
    run: m34Run(candidate),
    fastChecks: { light: { entries, summary: {} }, dark: { entries, summary: {} } },
    browserChecks: [],
  });
  assert.equal(result.readiness, "incomplete");
  assert.equal(
    result.diagnostics.coverage.provisional.filter((item) => item.roleId === "page.body-text").length,
    2,
    "两个模式都只有近似读数",
  );
  const record = result.fast.find((item) => item.roleId === "page.body-text" && item.mode === "light");
  assert.ok(record.method.endsWith(APPROXIMATE_METHOD_SUFFIX));
  assert.match(record.reason, /最终需浏览器确认/);
  assert.equal(result.fast.length, 2, "browser-required 不产生证据");
  assert.equal(result.diagnostics.coverage.fastDeferred.length, 2);
  assert.ok(result.diagnostics.gate.blockers.some((text) => text.includes("待浏览器确认")));
});

test("M3.4：近似压不过实测——同单元两种混合都按 M0 口径 rejected，来源各自可辨", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const pair = { mode: "light", roleId: "page.body-text", stateId: "dashboard-default", threshold: 4.5 };
  const base = m34Cover(candidate);
  const approximate = {
    ...m34Record(candidate.id, pair),
    method: `gradient-samples${APPROXIMATE_METHOD_SUFFIX}`,
  };
  const withApproximateFail = [...base, { ...approximate, result: "fail", ratio: 3.6, reason: "快速近似值 3.6" }];
  const first = m34Assess({ candidate, run, browserChecks: withApproximateFail });
  assert.equal(first.readiness, "rejected");
  assert.equal(first.failures.length, 1);
  assert.ok(first.failures[0].method.endsWith(APPROXIMATE_METHOD_SUFFIX));
  assert.equal(first.diagnostics.gate.failureCounts.approximate, 1);
  assert.ok(first.diagnostics.gate.blockers.some((text) => text.includes("快速近似失败")));
  assert.equal(first.diagnostics.coverage.verdictCounts.pass, m34RequiredPairs().length, "实测通过的单元仍算通过");
  assert.equal(first.diagnostics.methodDifferences.length, 1);

  const withApproximatePass = [
    ...base.map((record) =>
      record.mode === pair.mode && record.roleId === pair.roleId && record.stateId === pair.stateId
        ? { ...record, result: "fail", ratio: 3.6 }
        : record,
    ),
    { ...approximate, result: "pass", ratio: 11.25, reason: "快速近似值 11.25" },
  ];
  const second = m34Assess({ candidate, run, browserChecks: withApproximatePass });
  assert.equal(second.readiness, "rejected");
  assert.equal(second.failures.length, 1);
  assert.equal(second.failures[0].method, "browser-text-pixels");
  assert.equal(second.failures[0].ratio, 3.6, "失败记的是浏览器实测值，不是漂亮的近似值");
  assert.equal(second.diagnostics.gate.failureCounts.approximate, 0);
});

test("M3.4：同角色多条有效证据取最差比值，方法差异逐条记账", () => {
  const candidate = m34Candidate();
  const pair = { mode: "light", roleId: "table.comparison-cell", stateId: "dashboard-default", threshold: 4.5 };
  const cover = [
    ...m34Cover(candidate).filter(
      (record) => !(record.mode === pair.mode && record.roleId === pair.roleId && record.stateId === pair.stateId),
    ),
    m34Record(candidate.id, pair, { ratio: 7.4, method: "browser-text-pixels" }),
    m34Record(candidate.id, pair, { ratio: 6.0, method: "browser-text-shadow" }),
  ];
  const result = m34Assess({ candidate, run: m34Run(candidate), browserChecks: cover });
  assert.equal(result.readiness, "ready");
  const entry = result.diagnostics.reading.entries.find(
    (item) => item.roleId === pair.roleId && item.stateId === pair.stateId && item.mode === "light",
  );
  assert.equal(entry.ratio, 6.0);
  const difference = result.diagnostics.methodDifferences.find(
    (item) => item.roleId === pair.roleId && item.mode === "light",
  );
  assert.ok(difference);
  assert.ok(difference.methods.includes("browser-text-pixels"));
  assert.ok(difference.methods.includes("browser-text-shadow"));
  assert.ok(difference.samples.some((sample) => sample.ratio === 7.4));
});

test("M3.4：重复证据去重记账——同一记录给两遍不叠加失败，duplicates 记次数", () => {
  const candidate = m34Candidate();
  const cover = m34Cover(candidate);
  const result = m34Assess({ candidate, run: m34Run(candidate), browserChecks: [...cover, ...cover] });
  assert.equal(result.readiness, "ready");
  assert.equal(result.browser.length, cover.length * 2);
  assert.equal(result.diagnostics.duplicates.length, cover.length);
  assert.ok(result.diagnostics.duplicates.every((item) => item.times === 2));
  assert.equal(result.diagnostics.coverage.verdictCounts.pass, m34RequiredPairs().length);
  // 旧证据重复给两遍：过期只记一次，不因重复而放大
  const run = m34Run(candidate, { recordedInputHashes: { ...m34Run(candidate).inputHashes, policy: "7".repeat(64) } });
  const staleDuplicated = m34Assess({ candidate, run, browserChecks: [...cover, ...cover] });
  assert.equal(staleDuplicated.readiness, "incomplete");
  assert.equal(staleDuplicated.diagnostics.evidence.stale.length, 1);
  assert.equal(staleDuplicated.diagnostics.gate.failureCounts.measured, 0);
});

test("M3.4：例外规则——必要角色不得 not-applicable 免责，装饰角色合法例外不阻塞，缺理由即 incomplete", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const requiredGraphic = { mode: "light", roleId: "chart.timeline-segment", stateId: "dense-data", threshold: 3 };
  const withoutGraphic = m34Cover(candidate).filter((record) => record.roleId !== requiredGraphic.roleId);
  const excused = m34Assess({
    candidate,
    run,
    browserChecks: [
      ...withoutGraphic,
      m34Record(candidate.id, requiredGraphic, { result: "not-applicable", ratio: null, reason: "堆叠段无法分离前景" }),
    ],
  });
  assert.equal(excused.readiness, "incomplete");
  assert.ok(
    excused.diagnostics.coverage.gaps.some(
      (gap) => gap.roleId === requiredGraphic.roleId && /不得以 not-applicable/.test(gap.reason),
    ),
  );

  const decorative = { mode: "light", roleId: "deco.character-art", stateId: "characters-off", threshold: null };
  const graphicPass = [requiredGraphic, { ...requiredGraphic, mode: "dark" }].map((pair) =>
    m34Record(candidate.id, pair, { result: "pass", ratio: 4.2, method: "browser-canvas-pixels" }),
  );
  const legal = m34Assess({
    candidate,
    run,
    browserChecks: [
      ...withoutGraphic,
      ...graphicPass,
      m34Record(candidate.id, decorative, { result: "not-applicable", ratio: null, reason: "立绘不带文字" }),
    ],
  });
  assert.equal(legal.readiness, "ready");
  assert.equal(legal.diagnostics.exceptions.notApplicable.length, 1);
  assert.equal(legal.diagnostics.exceptions.notApplicable[0].roleId, decorative.roleId);

  const noReason = m34Assess({
    candidate,
    run,
    browserChecks: [
      ...withoutGraphic,
      ...graphicPass,
      m34Record(candidate.id, decorative, { result: "not-applicable", ratio: null, reason: "" }),
    ],
  });
  assert.equal(noReason.readiness, "incomplete");
  assert.ok(
    noReason.diagnostics.exceptions.missingReason.some((gap) => gap.roleId === decorative.roleId),
    "例外缺理由必须留痕",
  );
});

test("M3.4：证据过期一律 incomplete 并注明 STALE_EVIDENCE——出处不符逐个验证，齐全时不误报", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const cover = m34Cover(candidate);
  const scenarios = [
    ["roles", { ...run, inputHashes: { ...run.inputHashes, roles: "b".repeat(64) } }],
    ["derivation", { ...run, inputHashes: { ...run.inputHashes, derivation: "c".repeat(64) } }],
    ["policy", { ...run, recordedInputHashes: { ...run.inputHashes, policy: "d".repeat(64) } }],
    ["profiles", { ...run, recordedInputHashes: { ...run.inputHashes, profiles: "e".repeat(64) } }],
    [
      "sources",
      {
        ...run,
        sourceHashes: { ...run.sourceHashes, "public/skins.js": "f".repeat(64) },
        recordedSourceHashes: { ...run.recordedSourceHashes, "public/skins.js": "1".repeat(64) },
      },
    ],
    [
      "sources",
      {
        ...run,
        recordedSourceHashes: {
          ...run.recordedSourceHashes,
          "scripts/skin-palette/roles.mjs": "3".repeat(64),
        },
      },
    ],
    ["fixture", { ...run, fixture: { version: 99 } }],
    ["fixture", { ...run, recordedFixture: { version: M31_POLICY.versions.fixture + 1 } }],
  ];
  for (const [object, staleRun] of scenarios) {
    const result = m34Assess({ candidate, run: staleRun, browserChecks: cover });
    assert.equal(result.readiness, "incomplete", `${object} 出处不符必须 incomplete`);
    assert.ok(
      result.diagnostics.evidence.stale.some((item) => item.object === object),
      `${object} 必须记进 stale`,
    );
    assert.ok(
      result.diagnostics.gate.blockers.some((text) => text.includes("STALE_EVIDENCE") && text.includes(object)),
    );
  }

  const set = { inputHashes: run.inputHashes, candidates: [candidate] };
  const setRun = { ...run, candidateSet: set, candidateSetHash: hashCandidateSet(set) };
  const inSet = m34Assess({ candidate, run: setRun, browserChecks: cover });
  assert.equal(inSet.readiness, "ready", "出处齐全时不误报过期");
  assert.deepEqual(inSet.diagnostics.evidence.stale, []);
  assert.equal(inSet.diagnostics.identitySource, "run.candidateSet");

  const tamperedCandidates = [
    { ...candidate, modes: { light: { ...candidate.modes.light, accent: "#000000" }, dark: candidate.modes.dark } },
  ];
  const tamperedSet = { ...set, candidates: tamperedCandidates };
  const tampered = m34Assess({
    candidate,
    run: { ...run, candidateSet: tamperedSet, candidateSetHash: hashCandidateSet(tamperedSet) },
    browserChecks: cover,
  });
  assert.equal(tampered.readiness, "incomplete");
  assert.ok(tampered.diagnostics.evidence.stale.some((item) => item.object === "candidateSet"));

  const outsider = m34Candidate({ skinId: "mimo" });
  const otherSet = { ...set, candidates: [outsider] };
  const missing = m34Assess({
    candidate,
    run: { ...run, candidateSet: otherSet, candidateSetHash: hashCandidateSet(otherSet) },
    browserChecks: cover,
  });
  assert.equal(missing.readiness, "incomplete");
  assert.ok(missing.diagnostics.evidence.stale.some((item) => item.object === "candidateSet"));

  const oldPolicy = { ...M31_POLICY, readability: { ...M31_POLICY.readability, bodyTextMin: 3 } };
  const staleCandidate = m34Candidate({ policyHash: sha256Canonical(oldPolicy) });
  const byPolicy = m34Assess({
    candidate: staleCandidate,
    run: m34Run(staleCandidate),
    browserChecks: m34Cover(staleCandidate),
  });
  assert.equal(byPolicy.readiness, "incomplete");
  assert.ok(byPolicy.diagnostics.evidence.stale.some((item) => item.object === "policy"));
});

test("M3.4：视觉初筛三态——缺记录/有 pending 都是 incomplete，reject 是 rejected，绝不自动填 accept", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const cover = m34Cover(candidate);
  const missing = m34Assess({ candidate, run, browserChecks: cover, visualReview: null });
  assert.equal(missing.readiness, "incomplete");
  assert.equal(missing.visual.reviewed, false);
  assert.equal(missing.visual.verdict, null);
  assert.equal(missing.diagnostics.visualReview.provided, false);
  assert.ok(missing.diagnostics.gate.blockers.some((text) => text.includes("视觉初筛未完成")));

  const pendingItems = VISUAL_REVIEW_ITEMS.map((item, index) => ({
    id: item.id,
    verdict: index === 3 ? "pending" : "accept",
    notes: "看过",
    screenshots: ["shots/light-dashboard.png"],
  }));
  const pending = m34Assess({
    candidate,
    run,
    browserChecks: cover,
    visualReview: m34Visual({ verdict: "pending", items: pendingItems }),
  });
  assert.equal(pending.readiness, "incomplete");
  assert.equal(pending.visual.reviewed, false);

  const rejecting = m34Assess({
    candidate,
    run,
    browserChecks: cover,
    visualReview: m34Visual({
      verdict: "reject",
      items: VISUAL_REVIEW_ITEMS.map((item) => ({
        id: item.id,
        verdict: "reject",
        notes: "字标发虚",
        screenshots: ["shots/light-dashboard.png"],
      })),
    }),
  });
  assert.equal(rejecting.readiness, "rejected");
  assert.equal(rejecting.visual.verdict, "fail");

  // 记录不完整/不自洽/身份非法都直接抛错，不悄悄降级
  const accept = m34Visual();
  assert.throws(
    () =>
      m34Assess({ candidate, run, browserChecks: cover, visualReview: { ...accept, items: accept.items.slice(0, 7) } }),
    TypeError,
    /缺少必填项/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run,
        browserChecks: cover,
        visualReview: { ...accept, items: accept.items.map((item) => ({ ...item, screenshots: [] })) },
      }),
    TypeError,
    /必须记录截图路径/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run,
        browserChecks: cover,
        visualReview: { ...accept, verdict: "reject", items: accept.items },
      }),
    TypeError,
    /不一致/,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: cover, visualReview: { ...accept, by: "robot" } }),
    TypeError,
    /必须是/,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: cover, visualReview: { ...accept, reviewer: "" } }),
    TypeError,
    /reviewer/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run,
        browserChecks: cover,
        visualReview: {
          ...accept,
          items: accept.items.map((item, index) => (index === 0 ? { ...item, notes: "  " } : item)),
        },
      }),
    TypeError,
    /必须写意见/,
  );
});

test("M3.4：代理初筛与用户选择分离——by 可辨，评估不记录选中谁，也没有单一总分", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const user = m34Assess({
    candidate,
    run,
    browserChecks: m34Cover(candidate),
    visualReview: m34Visual({ by: "user", reviewer: "silverzhou" }),
  });
  assert.equal(user.readiness, "ready");
  assert.equal(user.diagnostics.visualReview.by, "user");
  assert.equal(user.diagnostics.visualReview.reviewer, "silverzhou");
  assert.match(user.diagnostics.gate.note, /selections\.json/);
  assert.equal("decisionSource" in user, false, "评估不代填用户选择");
  assert.equal("selected" in user.diagnostics, false);

  const proxy = m34Assess({ candidate, run, browserChecks: m34Cover(candidate) });
  assert.equal(proxy.readiness, "ready");
  assert.equal(proxy.diagnostics.visualReview.by, "proxy");
  assert.deepEqual(
    Object.keys(proxy).sort(),
    [
      "browser",
      "candidateHash",
      "candidateId",
      "diagnostics",
      "fast",
      "failures",
      "readiness",
      "schemaVersion",
      "unmeasured",
      "visual",
    ].sort(),
  );
  assert.equal(proxy.diagnostics.gate.machineOnly, true);
  assert.equal(proxy.diagnostics.visualReview.items.length, VISUAL_REVIEW_ITEMS.length);
  assert.equal(proxy.diagnostics.visualReview.items[0].outcome, "accept");
  // 没有单一分数：coverage.verdictCounts 是逐单元判读的直方图
  assert.ok(typeof proxy.diagnostics.coverage.verdictCounts === "object");
  assert.equal("score" in proxy.diagnostics, false);
  assert.equal("accepted" in proxy.diagnostics, false);
});

test("M3.4：阈值与判读自证——拿图形阈值冒充正文、或先四舍五入再改判都直接抛错", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const cover = m34Cover(candidate);
  // ① 阈值改成 3（图形阈值）却记正文 pass：目录里 page.body-text 是 4.5
  const wrongThreshold = m34Cover(candidate).map((record) =>
    record.roleId === "page.body-text" && record.mode === "light" ? { ...record, threshold: 3, ratio: 3.1 } : record,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: wrongThreshold }),
    TypeError,
    /page\.body-text.*阈值 3 与角色目录阈值 4\.5 不一致/,
  );
  // ② 阈值正确但 result 与全精度比值不符：4.4999 对 4.5 只能记 fail，不能记 pass
  const roundedUp = m34Cover(candidate).map((record) =>
    record.roleId === "page.body-text" && record.mode === "light" ? { ...record, ratio: 4.4999 } : record,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: roundedUp }),
    TypeError,
    /result=pass 与全精度比值 4\.4999 \/ 阈值 4\.5 不一致/,
  );
  // ③ 相反方向：比值明显达标却记 fail
  const roundedDown = m34Cover(candidate).map((record) =>
    record.roleId === "page.body-text" && record.mode === "light" ? { ...record, result: "fail" } : record,
  );
  assert.throws(() => m34Assess({ candidate, run, browserChecks: roundedDown }), TypeError, /result=fail 与全精度比值/);
  // ④ 阈值-less 角色不得产出 pass/fail
  const thresholdless = [
    ...m34Cover(candidate),
    m34Record(
      candidate.id,
      { mode: "light", roleId: "deco.character-art", stateId: "characters-off", threshold: 4.5 },
      {
        threshold: 4.5,
        ratio: 5,
      },
    ),
  ];
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: thresholdless }),
    TypeError,
    /无阅读阈值，不得产出 pass/,
  );
  // ⑤ 边界：恰好等于阈值算通过
  const exact = m34Cover(candidate).map((record) =>
    record.roleId === "page.body-text" && record.mode === "light" ? { ...record, ratio: 4.5 } : record,
  );
  const boundary = m34Assess({ candidate, run, browserChecks: exact });
  assert.equal(boundary.readiness, "ready");
  assert.equal(boundary.diagnostics.reading.worst.headroom, 1);
  assert.equal(cover.length, m34RequiredPairs().length);
});

test("M3.4：浏览器记录必须带状态锚点——stateId 为 null 不能冒充各状态都已实测", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  // 复现复核用例：把全部浏览器记录的 stateId 改成 null
  const unanchored = m34Cover(candidate).map((record) => ({ ...record, stateId: null }));
  const result = m34Assess({ candidate, run, browserChecks: unanchored });
  assert.equal(result.readiness, "incomplete", "104 条无锚点记录不能覆盖 132 个必要单元");
  assert.equal(result.diagnostics.coverage.verdictCounts.pass ?? 0, 0, "无一条单元算通过");
  assert.equal(result.diagnostics.coverage.gaps.length, m34RequiredPairs().length);
  assert.equal(result.diagnostics.coverage.unanchoredBrowser.length, unanchored.length);
  assert.ok(result.diagnostics.gate.blockers.some((text) => text.includes("没有状态锚点")));
  // 带锚点的那部分仍然照常覆盖：补回一条后缺口少一个
  const anchored = m34Cover(candidate);
  const oneBack = m34Assess({ candidate, run, browserChecks: [...unanchored, anchored[0]] });
  assert.equal(oneBack.diagnostics.coverage.unanchoredBrowser.length, unanchored.length);
  assert.equal(oneBack.diagnostics.coverage.gaps.length, m34RequiredPairs().length - 1);
});

test("M3.4：出处不齐即 incomplete——缺总集/产出时摘要/源摘要/fixture 都不能 ready", () => {
  const candidate = m34Candidate();
  const complete = m34Run(candidate);
  const cover = m34Cover(candidate);
  assert.equal(m34Assess({ candidate, run: complete, browserChecks: cover }).readiness, "ready");
  const missing = [
    ["candidateSet", { ...complete, candidateSet: undefined, candidateSetHash: undefined }],
    ["recordedInputHashes", { ...complete, recordedInputHashes: undefined }],
    ["recordedInputHashes", { ...complete, recordedInputHashes: {} }],
    ["sourceHashes", { ...complete, sourceHashes: undefined }],
    ["sourceHashes", { ...complete, sourceHashes: { "public/skins.js": "a".repeat(64) } }],
    ["recordedSourceHashes", { ...complete, recordedSourceHashes: undefined }],
    ["recordedSourceHashes", { ...complete, recordedSourceHashes: {} }],
    ["fixture", { ...complete, fixture: undefined }],
    ["recordedFixture", { ...complete, recordedFixture: undefined }],
  ];
  for (const [object, run] of missing) {
    const result = m34Assess({ candidate, run, browserChecks: cover });
    assert.equal(result.readiness, "incomplete", `缺 ${object} 不能 ready`);
    assert.ok(
      result.diagnostics.evidence.unverified.some((item) => item.startsWith(object)),
      `${object} 必须记进 unverified`,
    );
    assert.ok(result.diagnostics.gate.blockers.some((text) => text.includes("无法核验") && text.includes(object)));
  }
});

test("M3.4：空对象/半截摘要都不算已核验——复现复核用例，缺字段不能放行 ready", () => {
  const candidate = m34Candidate();
  const complete = m34Run(candidate);
  const cover = m34Cover(candidate);
  // 复核复现：{} 的输入摘要 + 只覆盖两个文件的源摘要 + 没有 recordedFixture
  const hollow = {
    ...complete,
    recordedInputHashes: {},
    sourceHashes: {
      "public/skins.js": "a".repeat(64),
      "scripts/skin-palette/evaluate.mjs": "b".repeat(64),
    },
    recordedSourceHashes: {
      "public/skins.js": "a".repeat(64),
      "scripts/skin-palette/evaluate.mjs": "b".repeat(64),
    },
    recordedFixture: undefined,
  };
  const result = m34Assess({ candidate, run: hollow, browserChecks: cover });
  assert.equal(result.readiness, "incomplete", "出处缺字段时不能 ready");
  assert.deepEqual(result.failures, [], "本条没有技术失败，出路只该是出处缺件");
  assert.equal(result.diagnostics.evidence.stale.length, 0, "这不是过期，是缺件");
  const unverified = result.diagnostics.evidence.unverified;
  assert.ok(
    unverified.some((item) => item.startsWith("recordedInputHashes") && item.includes(RECORDED_INPUT_FIELDS[0])),
    `空对象要点名缺哪些字段：${unverified.join("；")}`,
  );
  assert.ok(
    unverified.some((item) => item.startsWith("sourceHashes") && item.includes("scripts/skin-palette/assess.mjs")),
    "半截源摘要要点名缺哪些文件",
  );
  assert.ok(
    unverified.some((item) => item.startsWith("recordedFixture")),
    "没有 recordedFixture 就是核不了夹具版本",
  );
  // 补齐任意一项都还不算齐：缺件逐项消解，全齐才 ready
  const oneFilled = {
    ...hollow,
    recordedInputHashes: { ...complete.inputHashes },
  };
  assert.equal(m34Assess({ candidate, run: oneFilled, browserChecks: cover }).readiness, "incomplete");
  const allFilled = {
    ...oneFilled,
    sourceHashes: { ...complete.sourceHashes },
    recordedSourceHashes: { ...complete.recordedSourceHashes },
    recordedFixture: { ...complete.fixture },
  };
  assert.equal(m34Assess({ candidate, run: allFilled, browserChecks: cover }).readiness, "ready");
});

test("M3.4：必需源文件清单覆盖实际加载的页面/样式文件——逐个缺、逐个变都逃不过", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const cover = m34Cover(candidate);
  // 总计划 4.1（第 155 行）点名的最低覆盖范围，加同一句"至少"口径内的 public/skins.css
  // （index.html 第 34 行加载它，装逐皮肤的颜色/渐变/透明度规则）。实测量的是浏览器里
  // 真正渲染出来的页面，少要一份，页面改了而证据照样"看起来"属于当前版本。
  const pageAndStyleFiles = [
    "public/index.html",
    "public/skin-palettes.js",
    "public/styles.css",
    "public/skins.css",
    "public/app.js",
    "public/app-state.js",
    "public/skin-ui.js",
    "public/skin-picker.js",
  ];
  for (const file of pageAndStyleFiles) {
    assert.ok(REQUIRED_SOURCE_FILES.includes(file), `必需清单遗漏 ${file}（页面/样式文件必须在核验范围内）`);
  }
  const timelineFile = "public/timeline-utils.js";
  assert.equal(REQUIRED_SOURCE_FILES.length, 26);
  assert.equal(new Set(REQUIRED_SOURCE_FILES).size, 26);
  for (const file of [
    "scripts/skin-palette/focus-outline-pixels.mjs",
    "scripts/skin-palette/focus-outline-browser.mjs",
  ]) {
    assert.equal(
      REQUIRED_SOURCE_FILES.filter((entry) => entry === file).length,
      1,
      `${file} must join both loops below`,
    );
  }
  assert.ok(REQUIRED_SOURCE_FILES.includes(timelineFile), "派生时间线计算源码必须进入候选评审依赖清单");
  // 逐个从两份摘要里摘掉 → incomplete，并点名缺的是哪个文件
  for (const file of REQUIRED_SOURCE_FILES) {
    const without = { ...run.sourceHashes };
    delete without[file];
    const recordedWithout = { ...run.recordedSourceHashes };
    delete recordedWithout[file];
    const dropped = m34Assess({
      candidate,
      run: { ...run, sourceHashes: without, recordedSourceHashes: recordedWithout },
      browserChecks: cover,
    });
    assert.equal(dropped.readiness, "incomplete", `两份摘要都缺 ${file} 不能 ready`);
    assert.ok(
      dropped.diagnostics.evidence.unverified.some((item) => item.startsWith("sourceHashes") && item.includes(file)),
      `缺 ${file} 必须记进 unverified`,
    );
  }
  // 逐个改动"证据产出时"的摘要 → STALE_EVIDENCE（摘要齐但过期，不是缺件）
  for (const file of REQUIRED_SOURCE_FILES) {
    const changed = m34Assess({
      candidate,
      run: { ...run, recordedSourceHashes: { ...run.recordedSourceHashes, [file]: "c".repeat(64) } },
      browserChecks: cover,
    });
    assert.equal(changed.readiness, "incomplete", `${file} 摘要变了必须 incomplete`);
    assert.deepEqual(changed.diagnostics.evidence.unverified, [], "摘要齐全时的过期不是缺件");
    assert.ok(
      changed.diagnostics.evidence.stale.some((item) => item.object === "sources" && item.detail.includes(file)),
      `${file} 必须记进 stale`,
    );
    assert.ok(
      changed.diagnostics.gate.blockers.some((text) => text.includes("STALE_EVIDENCE") && text.includes(file)),
      `${file} 的过期必须进 blockers`,
    );
  }
});

test("M3.4：无状态锚点的失败记录仍算失败——证明不了覆盖，但必须 rejected", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const cover = m34Cover(candidate);
  // 复核复现：一条 stateId 为 null 的明确失败（对比度 1:1）。锚点缺失只说明测不到具体状态，
  // 不说明这条读数可以不算——M0 契约按"任何 fail 记录"要求 rejected。
  const stateless = m34Record(candidate.id, m34RequiredPairs()[0], {
    stateId: null,
    result: "fail",
    ratio: 1,
  });
  const result = m34Assess({ candidate, run, browserChecks: [...cover, stateless] });
  assert.equal(result.readiness, "rejected", "无状态失败不能被覆盖网格吞掉");
  assert.deepEqual(
    result.failures.map((record) => [record.roleId, record.stateId, record.ratio]),
    [[stateless.roleId, null, 1]],
    "失败汇总必须收进这条无状态记录",
  );
  assert.equal(result.diagnostics.gate.failureCounts.measured, 1, "浏览器实测失败计 measured");
  assert.equal(result.diagnostics.gate.failureCounts.approximate, 0);
  // 覆盖网格仍不认它：必要单元照旧算全，缺锚点单独留痕
  assert.equal(result.diagnostics.coverage.verdictCounts.pass, m34RequiredPairs().length);
  assert.equal(result.diagnostics.coverage.unanchoredBrowser.length, 1);
  assert.ok(result.diagnostics.gate.blockers.some((text) => text.includes("没有状态锚点")));
  // 同样的记录若是 pass，一样只算"无锚点"而不算通过：fail/pass 都不进覆盖
  const statelessPass = { ...stateless, result: "pass", ratio: m34RequiredPairs()[0].threshold * 1.5 };
  const passed = m34Assess({ candidate, run, browserChecks: [...cover, statelessPass] });
  assert.equal(passed.readiness, "incomplete");
  assert.deepEqual(passed.failures, []);
});

test("M3.4：真实 fast 的装饰/字标例外不再堵死 ready——转成带理由的 not-applicable，真正缺测保留", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const realFast = evaluatePalette({
    skinId: candidate.skinId,
    mode: "light",
    tokens: candidate.modes.light,
    roleCatalog: ROLE_CATALOG,
    policy: M31_POLICY,
  });
  const decorative = realFast.entries.filter((entry) => {
    const role = ROLE_CATALOG.find((item) => item.id === entry.roleId);
    return role?.required !== true && entry.status === "unmeasured";
  });
  assert.ok(decorative.length > 0, "M3.1 对阈值-less 角色报的就是 unmeasured");
  // 只把真实 fast 里的装饰/字标例外接进来（M31 结构夹具本身有 8 个真实失败，与本条无关）
  const exceptionsOnly = { entries: decorative, summary: realFast.summary };
  const result = m34Assess({
    candidate,
    run,
    browserChecks: m34Cover(candidate),
    fastChecks: { light: exceptionsOnly, dark: exceptionsOnly },
  });
  assert.equal(result.readiness, "ready", "装饰/字标例外不该永久堵死 ready");
  for (const entry of decorative) {
    const record = result.fast.find((item) => item.roleId === entry.roleId && item.mode === "light");
    assert.equal(record.result, "not-applicable", `${entry.roleId} 必须转成例外而不是缺测`);
    assert.equal(record.ratio, null);
    assert.ok(record.reason.length > 0, "例外必须带理由");
  }
  assert.equal(result.unmeasured.length, 0);
  assert.ok(
    result.diagnostics.exceptions.notApplicable.some((item) => item.roleId === decorative[0].roleId),
    "例外要在 diagnostics 里留痕",
  );
  // 有阈值却测不到的真正缺测保持 unmeasured
  const genuinelyMissing = {
    entries: [
      {
        roleId: "chart.timeline-segment",
        status: "unmeasured",
        threshold: 3,
        method: "canvas",
        methodDetail: "路径 stroke 不可分离",
      },
    ],
  };
  const kept = m34Assess({
    candidate,
    run,
    browserChecks: m34Cover(candidate),
    fastChecks: { light: genuinelyMissing, dark: genuinelyMissing },
  });
  assert.equal(kept.readiness, "incomplete");
  assert.equal(kept.unmeasured.length, 2);
  assert.equal(kept.unmeasured[0].result, "unmeasured");
  assert.match(kept.unmeasured[0].reason, /路径 stroke 不可分离/);
});

test("M3.4：输出深冻不连冻调用方记录——失败与缺测两条路径都不冻输入", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const failing = m34Cover(candidate).map((record) =>
    record.roleId === "page.body-text" && record.mode === "light" ? { ...record, result: "fail", ratio: 3.2 } : record,
  );
  const missing = m34Cover(candidate).map((record) =>
    record.roleId === "input.value" && record.mode === "dark"
      ? { ...record, result: "unmeasured", ratio: null, reason: "该节点未渲染" }
      : record,
  );
  const rejected = m34Assess({ candidate, run, browserChecks: failing });
  const incomplete = m34Assess({ candidate, run, browserChecks: missing });
  for (const record of failing) assert.equal(Object.isFrozen(record), false, "失败路径不许冻住调用方记录");
  for (const record of missing) assert.equal(Object.isFrozen(record), false, "缺测路径不许冻住调用方记录");
  assert.equal(Object.isFrozen(rejected.failures[0]), true);
  assert.equal(Object.isFrozen(incomplete.unmeasured[0]), true);
  assert.notEqual(rejected.failures[0], failing[0], "输出里必须是副本");
  assert.equal(rejected.failures[0].ratio, 3.2);
  assert.equal(incomplete.unmeasured[0].reason, "该节点未渲染");
});

test("M3.4：手工补测只进 diagnostics——七项注解必填，定性意见不冒充数值，也不进门禁桶", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const supplement = {
    roleId: "input.placeholder",
    stateId: "dialog-import-open",
    position: "x=10,y=20",
    foreground: "#23313C",
    background: "rgba(69,86,102,0.76)",
    method: "manual alpha composite",
    evidence: "shots/manual-1.png",
    ratio: 3.1,
    threshold: 4.5,
  };
  const result = m34Assess({
    candidate,
    run,
    browserChecks: m34Cover(candidate),
    visualReview: m34Visual({ supplement: [supplement] }),
  });
  assert.equal(result.readiness, "ready");
  assert.deepEqual(result.diagnostics.manualSupplement, [supplement]);
  assert.equal(result.fast.length + result.browser.length, m34RequiredPairs().length, "人工数值没有塞进机器桶");

  const opinion = {
    roleId: "input.placeholder",
    stateId: null,
    position: "对话框左上角",
    foreground: "#23313C",
    background: "半透明叠加，无法取单一值",
    method: "肉眼观察",
    evidence: "shots/manual-2.png",
  };
  const qualitative = m34Assess({
    candidate,
    run,
    browserChecks: m34Cover(candidate),
    visualReview: m34Visual({ supplement: [opinion] }),
  });
  assert.equal(qualitative.readiness, "ready");
  assert.equal(qualitative.diagnostics.manualSupplement[0].ratio, null);

  for (const field of ["roleId", "stateId", "position", "foreground", "background", "method", "evidence"]) {
    const broken = { ...supplement };
    delete broken[field];
    assert.throws(
      () =>
        m34Assess({
          candidate,
          run,
          browserChecks: m34Cover(candidate),
          visualReview: m34Visual({ supplement: [broken] }),
        }),
      TypeError,
      new RegExp(field),
    );
  }
  const bad = (patch) => m34Visual({ supplement: [{ ...supplement, ...patch }] });
  assert.throws(
    () =>
      m34Assess({ candidate, run, browserChecks: m34Cover(candidate), visualReview: bad({ roleId: "no.such-role" }) }),
    TypeError,
    /角色目录/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run,
        browserChecks: m34Cover(candidate),
        visualReview: bad({ stateId: "no-such-state" }),
      }),
    TypeError,
    /已知状态/,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: m34Cover(candidate), visualReview: bad({ ratio: "3.1" }) }),
    TypeError,
    /有限数/,
  );
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: m34Cover(candidate), visualReview: bad({ position: "   " }) }),
    TypeError,
    /position/,
  );
});

test("M3.4：4.5—7 可 ready 但读数显示优选差距；必要文字/图形阈值保持，冗余项退出数值门槛", () => {
  const candidate = m34Candidate();
  const cover = m34Cover(candidate, (pair) =>
    pair.roleId === "page.body-text" && pair.mode === "light" ? { ratio: 5.0 } : undefined,
  );
  const result = m34Assess({ candidate, run: m34Run(candidate), browserChecks: cover });
  assert.equal(result.readiness, "ready", "4.5—7 之间允许 ready");
  const entry = result.diagnostics.reading.entries.find(
    (item) => item.roleId === "page.body-text" && item.mode === "light" && item.stateId === "dashboard-default",
  );
  assert.equal(entry.ratio, 5.0);
  assert.equal(entry.threshold, 4.5);
  assert.equal(entry.preferred, 7);
  assert.equal(entry.preferredMet, false);
  assert.ok(Math.abs(entry.preferredHeadroom - 5 / 7) < 1e-12);
  assert.ok(result.diagnostics.reading.preferredShortfalls.some((item) => item.roleId === "page.body-text"));
  assert.equal(result.diagnostics.reading.worst.roleId, "page.body-text");
  for (const roleId of ["chart.timeline-segment", "chart.legend-swatch", "focus.outline"]) {
    assert.equal(result.browser.find((item) => item.roleId === roleId).threshold, 3, `${roleId} 的阈值必须保持 3`);
  }
  for (const roleId of ["spotlight.tinted-surface", "chart.detail-fill"]) {
    const role = ROLE_CATALOG.find((item) => item.id === roleId);
    assert.equal(role.required, false);
    assert.equal(role.threshold, null);
    assert.equal(result.browser.some((item) => item.roleId === roleId), false);
  }
  assert.equal(result.browser.find((item) => item.roleId === "chart.axis-text").threshold, 4.5);
});

test("M3.4：fastResultToRecords 适配器——browser-required 只留路由，近似打尾缀，缺测带理由", () => {
  const adapted = fastResultToRecords({
    candidateId: "cand-x",
    mode: "light",
    fastResult: {
      entries: [
        {
          roleId: "page.body-text",
          status: "pass",
          ratio: 7.2,
          threshold: 4.5,
          method: "solid",
          effectiveForeground: "#23313C",
          effectiveBackground: "#F4F1EA",
        },
        {
          roleId: "chart.legend-swatch",
          status: "browser-required",
          threshold: 3,
          method: "layered",
          methodDetail: "堆叠",
        },
        {
          roleId: "chart.timeline-segment",
          status: "unmeasured",
          threshold: 3,
          method: "canvas",
          methodDetail: "路径 stroke 不可分离",
        },
        {
          roleId: "focus.outline",
          status: "fail",
          ratio: 2.1,
          threshold: 3,
          method: "gradient-samples",
          approximate: true,
        },
      ],
    },
  });
  assert.equal(adapted.records.length, 3);
  assert.equal(adapted.deferred.length, 1);
  assert.equal(adapted.deferred[0].roleId, "chart.legend-swatch");
  const [solid, unmeasured, approximate] = adapted.records;
  assert.equal(solid.result, "pass");
  assert.equal(solid.stateId, null);
  assert.equal(solid.reason, "");
  assert.ok(solid.evidence.includes("fast"));
  assert.ok(solid.evidence.includes("#23313C"));
  assert.equal(unmeasured.result, "unmeasured");
  assert.equal(unmeasured.ratio, null);
  assert.match(unmeasured.reason, /路径 stroke 不可分离/);
  assert.equal(approximate.result, "fail");
  assert.ok(approximate.method.endsWith(APPROXIMATE_METHOD_SUFFIX));
  assert.match(approximate.reason, /最终需浏览器确认/);
  assert.throws(
    () => fastResultToRecords({ candidateId: "c", mode: "noon", fastResult: { entries: [] } }),
    TypeError,
    /非法 mode/,
  );
  assert.throws(
    () => fastResultToRecords({ candidateId: "c", mode: "light", stateId: "nope", fastResult: { entries: [] } }),
    TypeError,
    /未知 stateId/,
  );
  assert.throws(
    () =>
      fastResultToRecords({
        candidateId: "c",
        mode: "light",
        fastResult: { entries: [{ roleId: "no.such", status: "pass" }] },
      }),
    TypeError,
    /未知角色/,
  );
  assert.throws(
    () =>
      fastResultToRecords({
        candidateId: "c",
        mode: "light",
        fastResult: { entries: [{ roleId: "page.body-text", status: "maybe" }] },
      }),
    TypeError,
    /未知 fast 状态/,
  );
  assert.throws(
    () => fastResultToRecords({ candidateId: "c", mode: "light", fastResult: { entries: "no" } }),
    TypeError,
    /entries 必须是数组/,
  );
});

test("M3.4：输入校验与纯度——坏输入立即抛错，输入不被改写，输出深冻", () => {
  const candidate = m34Candidate();
  const run = m34Run(candidate);
  const before = canonicalJson(candidate);
  const cover = m34Cover(candidate);
  const coverBefore = canonicalJson(cover);
  const result = m34Assess({ candidate, run, browserChecks: cover });
  assert.equal(canonicalJson(candidate), before, "候选对象不被改写");
  assert.equal(canonicalJson(cover), coverBefore, "传入的记录数组不被改写");
  assert.throws(() => {
    result.readiness = "ready";
  }, TypeError);
  assert.throws(() => {
    result.diagnostics.coverage.gaps.push({});
  }, TypeError);
  assert.throws(() => {
    result.fast.push({});
  }, TypeError);

  assert.throws(() => m34Assess({ candidate: { id: "x" }, run, browserChecks: [] }), TypeError, /候选/);
  assert.throws(
    () => m34Assess({ candidate, run, browserChecks: [m34Record("someone-else", m34RequiredPairs()[0])] }),
    TypeError,
    /不能混入别人的证据/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run,
        browserChecks: [{ ...m34Record(candidate.id, m34RequiredPairs()[0]), result: "unmeasured", ratio: 5 }],
      }),
    TypeError,
    /M0 契约/,
  );
  assert.throws(
    () => m34Assess({ candidate, run: { policy: M31_POLICY }, browserChecks: [] }),
    TypeError,
    /inputHashes/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run: { ...run, policy: { ...M31_POLICY, readability: { bodyTextMin: 4.5 } } },
        browserChecks: [],
      }),
    TypeError,
    /policy/,
  );
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run: { ...run, policy: { ...M31_POLICY, readability: { ...M31_POLICY.readability, bodyTextMin: 3 } } },
        browserChecks: [],
      }),
    TypeError,
    /readability/,
  );
  assert.throws(() => m34Assess({ candidate, run, browserChecks: "records" }), TypeError, /browserChecks/);
  assert.throws(
    () => m34Assess({ candidate, run, fastChecks: { light: { entries: "no" } }, browserChecks: [] }),
    TypeError,
    /entries/,
  );
  assert.throws(
    () => m34Assess({ candidate, run: { ...run, fixture: { version: 0 } }, browserChecks: cover }),
    TypeError,
    /fixture/,
  );
  const set = { inputHashes: run.inputHashes, candidates: [candidate] };
  assert.throws(
    () =>
      m34Assess({
        candidate,
        run: { ...run, candidateSet: set, candidateSetHash: "9".repeat(64) },
        browserChecks: cover,
      }),
    TypeError,
    /candidateSetHash/,
  );
  const selfInconsistent = m34Assess({
    candidate,
    run: { ...run, inputHashes: { ...run.inputHashes, policy: "8".repeat(64) } },
    browserChecks: cover,
  });
  assert.equal(selfInconsistent.readiness, "incomplete", "摘要自相矛盾不能当 ready");
  assert.ok(selfInconsistent.diagnostics.evidence.stale.some((item) => item.object === "policy"));
});

function createStableFullPageNodePage({
  styleAttributePresent = false,
  initialGutter = null,
  initialGutterPriority = "",
  classicGutter = 15,
  cssSupported = true,
  driftOnStable = false,
  addUnrelatedOnScreenshot = false,
  screenshotError = null,
  failRestoreScroll = false,
  restoredScroll = null,
  afterScreenshot = null,
  fullPageHidesTooltip = false,
} = {}) {
  const declarations = new Map();
  if (initialGutter !== null)
    declarations.set("scrollbar-gutter", { value: initialGutter, priority: initialGutterPriority });
  let hasStyleAttribute = styleAttributePresent || declarations.size > 0;
  let layoutDrift = false;
  let failNextScroll = false;
  const style = {
    get cssText() {
      return Array.from(
        declarations,
        ([property, entry]) => `${property}: ${entry.value}${entry.priority ? ` !${entry.priority}` : ""};`,
      ).join(" ");
    },
    getPropertyValue(property) {
      return declarations.get(property)?.value ?? "";
    },
    getPropertyPriority(property) {
      return declarations.get(property)?.priority ?? "";
    },
    setProperty(property, value, priority = "") {
      declarations.set(property, { value: String(value), priority: String(priority) });
      hasStyleAttribute = true;
      if (property === "scrollbar-gutter" && value === "stable") layoutDrift = driftOnStable;
      if (property === "scrollbar-gutter" && value !== "stable") layoutDrift = false;
    },
    removeProperty(property) {
      const previous = declarations.get(property)?.value ?? "";
      declarations.delete(property);
      if (property === "scrollbar-gutter") layoutDrift = false;
      return previous;
    },
  };
  const state = { innerWidth: 1200, innerHeight: 800, scrollX: 11, scrollY: 23 };
  const drift = { viewportInnerWidth: 0, htmlClientWidth: 0 };
  const tooltipRect = { x: 880, y: 300, width: 120, height: 24 };
  let guardInputHasStyleAttribute = false;
  const element = ({ tagName, id = "", className = "", rect, position = "static", display = "block" }) => ({
    tagName,
    id,
    className,
    position,
    display,
    getBoundingClientRect: () => {
      const value = rect();
      return { ...value, left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height };
    },
  });
  const guardInput = element({
    tagName: "INPUT",
    id: "guard-input",
    className: "guard-input",
    rect: () => ({ x: 320, y: 320, width: 160, height: 32 }),
  });
  guardInput.hasAttribute = (name) => name === "style" && guardInputHasStyleAttribute;
  guardInput.getAttribute = (name) => (name === "style" && guardInputHasStyleAttribute ? "" : null);
  guardInput.removeAttribute = (name) => {
    if (name === "style") guardInputHasStyleAttribute = false;
  };
  const root = element({
    tagName: "HTML",
    rect: () => ({ x: 0, y: 0, width: state.innerWidth, height: 2100 }),
  });
  Object.defineProperties(root, {
    style: { value: style },
    clientWidth: { get: () => state.innerWidth - classicGutter + drift.htmlClientWidth },
    clientHeight: { get: () => state.innerHeight },
    offsetWidth: { get: () => state.innerWidth },
    offsetHeight: { get: () => 2100 },
    scrollWidth: { get: () => state.innerWidth - classicGutter },
    scrollHeight: { get: () => 2100 },
  });
  root.hasAttribute = (name) => name === "style" && hasStyleAttribute;
  root.getAttribute = (name) => (name === "style" && hasStyleAttribute ? style.cssText : null);
  root.setAttribute = (name, value) => {
    if (name === "style") hasStyleAttribute = true;
    else throw new TypeError(`unsupported attribute ${name}=${value}`);
  };
  root.removeAttribute = (name) => {
    if (name === "style") hasStyleAttribute = false;
  };
  const body = element({
    tagName: "BODY",
    rect: () => ({ x: 0, y: 0, width: state.innerWidth - classicGutter, height: 2100 }),
  });
  Object.defineProperties(body, {
    clientWidth: { get: () => state.innerWidth - classicGutter },
    clientHeight: { get: () => 2100 },
    offsetWidth: { get: () => state.innerWidth - classicGutter },
    offsetHeight: { get: () => 2100 },
    scrollWidth: { get: () => state.innerWidth - classicGutter },
    scrollHeight: { get: () => 2100 },
  });
  const content = element({
    tagName: "MAIN",
    id: "shell",
    className: "shell",
    rect: () => ({ x: 65 + (layoutDrift ? 5 : 0), y: 0, width: 1070, height: 2100 }),
  });
  const fixed = element({
    tagName: "DIV",
    id: "fixed-target",
    rect: () => ({ x: 18, y: 16, width: 20, height: 14 }),
    position: "fixed",
  });
  const sticky = element({
    tagName: "DIV",
    id: "sticky-target",
    rect: () => ({ x: 65, y: 850, width: 280, height: 18 }),
    position: "sticky",
  });
  const locator = element({
    tagName: "DIV",
    id: "locator",
    rect: () => ({ x: 82 + (layoutDrift ? 5 : 0), y: 1710, width: 31, height: 21 }),
  });
  const tooltip = element({
    tagName: "DIV",
    id: "usageTooltip",
    className: "usage-tooltip",
    rect: () => tooltipRect,
  });
  const allElements = [root, body, content, fixed, sticky, locator, guardInput, tooltip];
  const document = {
    documentElement: root,
    body,
    querySelectorAll(selector) {
      if (selector === "input,textarea,[contenteditable]") return [guardInput];
      return selector === "*" ? allElements : [];
    },
  };
  const visualViewport = {
    get width() {
      return state.innerWidth - classicGutter;
    },
    get height() {
      return state.innerHeight;
    },
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
  };
  const window = {
    get innerWidth() {
      return state.innerWidth + drift.viewportInnerWidth;
    },
    get innerHeight() {
      return state.innerHeight;
    },
    get scrollX() {
      return state.scrollX;
    },
    get scrollY() {
      return state.scrollY;
    },
    visualViewport,
    scrollTo(x, y) {
      if (failNextScroll) {
        failNextScroll = false;
        throw new Error("injected scroll restore failure");
      }
      if (restoredScroll) {
        state.scrollX = restoredScroll.x;
        state.scrollY = restoredScroll.y;
        return;
      }
      state.scrollX = x;
      state.scrollY = y;
    },
  };
  const getComputedStyle = (node) => ({
    display: node.display,
    position: node.position,
    transform: "none",
    scrollbarGutter: node === root ? style.getPropertyValue("scrollbar-gutter") || "auto" : "auto",
  });
  const pageContext = createContext({
    argument: undefined,
    document,
    window,
    CSS: { supports: () => cssSupported },
    getComputedStyle,
    requestAnimationFrame: (callback) => callback(),
  });
  const page = {
    async evaluate(callback, argument) {
      pageContext.argument = argument;
      return structuredClone(await runInContext(`(${callback.toString()})(argument)`, pageContext));
    },
    async screenshot(options) {
      assert.equal(typeof options?.fullPage, "boolean");
      guardInputHasStyleAttribute = true;
      state.scrollX = 0;
      state.scrollY = 0;
      if (addUnrelatedOnScreenshot) style.setProperty("color", "rgb(1, 2, 3)", "important");
      if (options.fullPage && fullPageHidesTooltip) tooltip.display = "none";
      afterScreenshot?.({ drift, tooltip, tooltipRect, state });
      if (failRestoreScroll) failNextScroll = true;
      if (screenshotError) throw screenshotError;
      return png;
    },
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return {
    page,
    root,
    style,
    state,
    png,
    drift,
    tooltip,
    tooltipRect,
    get hasStyleAttribute() {
      return hasStyleAttribute;
    },
  };
}

function createMeasureFullPageHarness(
  probePage,
  fullPageFixture,
  { failAt = null, failureMode = null, failure = null } = {},
) {
  const fullPageAttempts = [];
  const viewportAttempts = [];
  const roleProbeStates = [];
  const clipScreenshots = [];
  let fullPageSucceeded = 0;
  let viewportSucceeded = 0;
  const page = {
    async evaluate(source, argument) {
      if (typeof source === "function") return fullPageFixture.page.evaluate(source, argument);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      if (tag === "node-probe") {
        roleProbeStates.push({
          scroll: [fullPageFixture.state.scrollX, fullPageFixture.state.scrollY],
          gutter: fullPageFixture.style.getPropertyValue("scrollbar-gutter"),
          gutterPriority: fullPageFixture.style.getPropertyPriority("scrollbar-gutter"),
        });
      }
      return probePage.evaluate(source, argument);
    },
    async screenshot(options) {
      if (options?.fullPage === true || options?.fullPage === false) {
        const attempts = options.fullPage ? fullPageAttempts : viewportAttempts;
        attempts.push({
          options,
          gutter: fullPageFixture.style.getPropertyValue("scrollbar-gutter"),
          gutterPriority: fullPageFixture.style.getPropertyPriority("scrollbar-gutter"),
        });
        assert.equal(
          fullPageFixture.style.getPropertyValue("scrollbar-gutter"),
          "stable",
          "整页截图必须由真实helper保护 classic gutter",
        );
        assert.equal(fullPageFixture.style.getPropertyPriority("scrollbar-gutter"), "important");
        if (options.fullPage && fullPageAttempts.length === failAt) {
          if (failureMode === "fixture") return fullPageFixture.page.screenshot(options);
          if (failureMode === "mutate-and-throw") {
            fullPageFixture.state.scrollX = 0;
            fullPageFixture.state.scrollY = 0;
            throw failure;
          }
        }
        const screenshot = await fullPageFixture.page.screenshot(options);
        if (options.fullPage) fullPageSucceeded += 1;
        else viewportSucceeded += 1;
        return screenshot;
      }
      clipScreenshots.push(options);
      assert.equal(
        fullPageFixture.style.getPropertyValue("scrollbar-gutter"),
        "",
        "角色 clip 不应留在helper临时保护内",
      );
      return probePage.screenshot(options);
    },
  };
  return {
    page,
    fullPageAttempts,
    viewportAttempts,
    roleProbeStates,
    clipScreenshots,
    get fullPageSucceeded() {
      return fullPageSucceeded;
    },
    get viewportSucceeded() {
      return viewportSucceeded;
    },
  };
}

test("D8q1：measureBrowserRoles经真实helper拍摄前后整页，角色clip维持原口径", async (t) => {
  await t.test("普通文字clip保持原样，helper恢复后才开始节点采样", async () => {
    const probePage = createScriptedPage(defaultHandlers());
    const fullPageFixture = createStableFullPageNodePage();
    const harness = createMeasureFullPageHarness(probePage, fullPageFixture);
    const role = m32Role("page.body-text");
    const result = await measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [role],
      policy: M31_POLICY,
    });

    assert.deepEqual(
      harness.fullPageAttempts.map((shot) => shot.options),
      [{ fullPage: true }, { fullPage: true }],
    );
    assert.equal(harness.fullPageSucceeded, 2);
    assert.ok(harness.roleProbeStates.length > 0);
    for (const snapshot of harness.roleProbeStates) {
      assert.deepEqual(snapshot, { scroll: [11, 23], gutter: "", gutterPriority: "" });
    }
    assert.equal(harness.clipScreenshots.length, 2);
    assert.ok(harness.clipScreenshots.every((shot) => shot.clip && shot.fullPage === undefined));
    assert.deepEqual(result.diagnostics.restoration.statePixelDiff, {
      identical: true,
      width: 1200,
      height: 2100,
      differingPixels: 0,
      maxChannelDelta: 0,
      bbox: null,
    });
    assert.deepEqual([fullPageFixture.state.scrollX, fullPageFixture.state.scrollY], [11, 23]);
    assert.equal(fullPageFixture.style.getPropertyValue("scrollbar-gutter"), "");
  });

  await t.test("badge.record仍只截图中央3×3核心", async () => {
    const sample = createD8f2Sample({ pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]) });
    const harness = createMeasureFullPageHarness(sample.page, sample.fullPageFixture);
    const result = await sample.run(harness.page);
    const band = JSON.parse(result.records[0].evidence).nodes[0].bands[0];

    assert.equal(band.scan.pixelCount, 9);
    assert.deepEqual(sample.screenshots, [{ x: 12.25, y: 22.5, width: 3, height: 3 }]);
    assert.deepEqual(
      harness.fullPageAttempts.map((shot) => shot.options),
      [{ fullPage: true }, { fullPage: true }],
    );
    assert.equal(harness.fullPageSucceeded, 2);
  });
});

test("A33：仅非零恢复差异复用原始前后状态帧", async (t) => {
  await t.test("非零差异保留原始双帧并绑定 capture 下标", async () => {
    const statePngs = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x31]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x32]),
    ];
    const probePage = createScriptedPage(
      defaultHandlers({
        "compare-images": () => ({
          identical: false,
          width: 1200,
          height: 2100,
          differingPixels: 68,
          maxChannelDelta: 1,
          bbox: { x: 39, y: 159, width: 1, height: 1 },
        }),
      }),
    );
    const fullPageFixture = createStableFullPageNodePage();
    const harness = createMeasureFullPageHarness(probePage, fullPageFixture);
    const delegatedScreenshot = harness.page.screenshot.bind(harness.page);
    let stateScreenshotIndex = 0;
    harness.page.screenshot = async (options) => {
      const returned = await delegatedScreenshot(options);
      if (options?.fullPage === true || options?.fullPage === false) {
        return statePngs[stateScreenshotIndex++];
      }
      return returned;
    };

    const result = await measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    });

    assert.equal(stateScreenshotIndex, 2, "状态帧直接复用既有前后截图，不新增截图");
    const binding = result.diagnostics.restoration.stateDiffCaptures;
    assert.deepEqual(binding, { before: result.captures.length - 2, after: result.captures.length - 1 });
    assert.deepEqual(result.captures[binding.before], {
      roleId: null,
      kind: "state-diff-before",
      clip: null,
      dpr: 1,
      scroll: { x: 0, y: 0 },
      pngBase64: statePngs[0].toString("base64"),
    });
    assert.deepEqual(result.captures[binding.after], {
      roleId: null,
      kind: "state-diff-after",
      clip: null,
      dpr: 1,
      scroll: { x: 0, y: 0 },
      pngBase64: statePngs[1].toString("base64"),
    });
  });

  await t.test("零差异不新增状态帧或绑定", async () => {
    const probePage = createScriptedPage(defaultHandlers());
    const fullPageFixture = createStableFullPageNodePage();
    const harness = createMeasureFullPageHarness(probePage, fullPageFixture);
    const result = await measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    });

    assert.equal(result.diagnostics.restoration.statePixelDiff.identical, true);
    assert.equal(Object.hasOwn(result.diagnostics.restoration, "stateDiffCaptures"), false);
    assert.equal(result.captures.filter((capture) => capture.roleId === null).length, 0);
    assert.equal(harness.fullPageAttempts.length, 2, "零差异没有额外状态截图");
  });

  await t.test("比较结果缺少 identical 时不按差异新增状态帧", async () => {
    const probePage = createScriptedPage(
      defaultHandlers({
        "compare-images": () => ({
          width: 1200,
          height: 2100,
          differingPixels: 68,
          maxChannelDelta: 1,
          bbox: { x: 39, y: 159, width: 1, height: 1 },
        }),
      }),
    );
    const fullPageFixture = createStableFullPageNodePage();
    const harness = createMeasureFullPageHarness(probePage, fullPageFixture);
    const result = await measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    });

    assert.equal(result.diagnostics.restoration.statePixelDiff.identical, undefined);
    assert.equal(Object.hasOwn(result.diagnostics.restoration, "stateDiffCaptures"), false);
    assert.equal(result.captures.filter((capture) => capture.roleId === null).length, 0);
    assert.equal(harness.fullPageAttempts.length, 2);
  });
});

test("D8q1：前整页截图失败并伴随恢复失败时不启动角色测量且保留双错", async () => {
  const screenshotError = new Error("injected baseline screenshot failure");
  const probePage = createScriptedPage(defaultHandlers());
  const fullPageFixture = createStableFullPageNodePage({ screenshotError, failRestoreScroll: true });
  const harness = createMeasureFullPageHarness(probePage, fullPageFixture, { failAt: 1, failureMode: "fixture" });

  await assert.rejects(
    measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], screenshotError);
      assert.strictEqual(error.cause, screenshotError);
      assert.ok(error.errors.some((item) => item.message.includes("injected scroll restore failure")));
      assert.equal(error.measurementEvidence.complete, false);
      assert.equal(error.measurementEvidence.phase, "before-state");
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.deepEqual(error.measurementEvidence.captures, []);
      assert.deepEqual(error.measurementEvidence.diagnostics.counts, {
        pass: 0,
        fail: 0,
        unmeasured: 0,
        notApplicable: 0,
      });
      assert.equal(error.measurementEvidence.diagnostics.partial, true);
      return true;
    },
  );
  assert.equal(harness.fullPageAttempts.length, 1);
  assert.equal(harness.fullPageSucceeded, 0);
  assert.equal(harness.roleProbeStates.length, 0, "基准整页失败不得进入角色采样");
  assert.equal(harness.clipScreenshots.length, 0);
});

test("D8q1：后整页截图失败不返回已计算的PASS且仍经helper恢复", async (t) => {
  const screenshotError = new Error("injected after-measurement screenshot failure");
  const handlers = defaultHandlers({
    scan: () =>
      scanResult([
        ["text-0-0", [0, 0, 0, 255]],
        ["text-1-0", [0, 0, 0, 255]],
      ]),
  });
  const controlPage = createScriptedPage(handlers);
  const control = await measureBrowserRoles({
    page: createMeasureFullPageHarness(controlPage, controlPage.fullPageFixture).page,
    candidate: null,
    mode: "light",
    stateId: "dashboard-default",
    roleCatalog: [m32Role("page.body-text")],
    policy: M31_POLICY,
  });
  assert.equal(control.records[0].result, "pass", "故障注入前，同一角色与样本应能得到PASS");

  const probePage = createScriptedPage(handlers);
  const fullPageFixture = createStableFullPageNodePage();
  const harness = createMeasureFullPageHarness(probePage, fullPageFixture, {
    failAt: 2,
    failureMode: "mutate-and-throw",
    failure: screenshotError,
  });

  await assert.rejects(
    measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    }),
    (error) => {
      assert.strictEqual(error, screenshotError);
      const partial = error.measurementEvidence;
      assert.equal(partial.complete, false);
      assert.equal(partial.phase, "after-state");
      assert.equal(partial.records.length, 1);
      assert.equal(partial.records[0].result, "pass");
      assert.equal(partial.records[0].ratio, control.records[0].ratio);
      assert.equal(partial.captures.length, 2);
      for (const capture of partial.captures) {
        assert.equal(
          capture.pngBase64,
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
        );
      }
      assert.deepEqual(partial.diagnostics.counts, { pass: 1, fail: 0, unmeasured: 0, notApplicable: 0 });
      assert.equal(partial.diagnostics.partial, true);
      t.diagnostic(
        JSON.stringify({
          originalError: error === screenshotError,
          phase: partial.phase,
          complete: partial.complete,
          records: partial.records.length,
          captures: partial.captures.length,
          counts: partial.diagnostics.counts,
        }),
      );
      return true;
    },
  );
  assert.equal(harness.fullPageAttempts.length, 2);
  assert.equal(harness.fullPageSucceeded, 1);
  assert.ok(harness.roleProbeStates.length > 0, "第一次整页基准成功后确实执行过角色测量");
  assert.equal(harness.clipScreenshots.length, 2);
  assert.deepEqual([fullPageFixture.state.scrollX, fullPageFixture.state.scrollY], [11, 23]);
  assert.equal(fullPageFixture.style.getPropertyValue("scrollbar-gutter"), "");
});

test("D21-C5-A：前整页原Error及AggregateError身份和cause顺序保持", async (t) => {
  const first = new Error("first cause");
  const second = new Error("second cause");
  for (const failure of [
    new Error("baseline", { cause: first }),
    new AggregateError([first, second], "baseline aggregate", { cause: first }),
  ]) {
    const probePage = createScriptedPage(defaultHandlers());
    const harness = createMeasureFullPageHarness(probePage, createStableFullPageNodePage(), {
      failAt: 1,
      failureMode: "mutate-and-throw",
      failure,
    });
    const errors = failure.errors;
    await assert.rejects(measureTextFixture(harness.page), (error) => {
      assert.strictEqual(error, failure);
      assert.strictEqual(error.cause, first);
      if (errors) {
        assert.strictEqual(error.errors, errors);
        assert.strictEqual(error.errors[0], first);
        assert.strictEqual(error.errors[1], second);
      }
      assert.equal(error.measurementEvidence.phase, "before-state");
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.deepEqual(error.measurementEvidence.captures, []);
      assert.equal(error.measurementEvidence.complete, false);
      assert.deepEqual(error.measurementEvidence.diagnostics.counts, {
        pass: 0,
        fail: 0,
        unmeasured: 0,
        notApplicable: 0,
      });
      t.diagnostic(
        JSON.stringify({
          name: error.name,
          originalError: error === failure,
          causePreserved: error.cause === first,
          errorsArrayPreserved: error.errors === errors,
          phase: error.measurementEvidence.phase,
          records: 0,
          captures: 0,
        }),
      );
      return true;
    });
    assert.equal(harness.roleProbeStates.length, 0);
    assert.equal(harness.clipScreenshots.length, 0);
  }
});

test("D21-C5-A：不可扩展或不可写证据的Error不被附加错误替换", async () => {
  const locked = new Error("locked evidence");
  const originalEvidence = { prior: true };
  Object.defineProperty(locked, "measurementEvidence", { value: originalEvidence, configurable: false });
  for (const failure of [Object.freeze(new Error("frozen")), locked]) {
    const probePage = createScriptedPage(defaultHandlers());
    const harness = createMeasureFullPageHarness(probePage, createStableFullPageNodePage(), {
      failAt: 1,
      failureMode: "mutate-and-throw",
      failure,
    });
    await assert.rejects(measureTextFixture(harness.page), (error) => error === failure);
  }
  assert.strictEqual(locked.measurementEvidence, originalEvidence);
});

test("D21-C5-A：图像比较失败保留partial记录而非返回PASS，非对象错原样抛出", async (t) => {
  for (const failure of [new Error("comparison failed"), 0, null, undefined]) {
    const page = createScriptedPage(
      defaultHandlers({
        "compare-images": () => {
          throw failure;
        },
      }),
    );
    await assert.rejects(measureTextFixture(page), (error) => {
      assert.strictEqual(error, failure);
      if (failure instanceof Error) {
        assert.equal(error.measurementEvidence.phase, "compare");
        assert.equal(error.measurementEvidence.records.length, 1);
        assert.equal(error.measurementEvidence.captures.length, 2);
        assert.equal(error.measurementEvidence.complete, false);
        assert.equal(
          Object.values(error.measurementEvidence.diagnostics.counts).reduce((sum, count) => sum + count, 0),
          1,
        );
        t.diagnostic(
          JSON.stringify({
            originalError: true,
            phase: error.measurementEvidence.phase,
            counts: error.measurementEvidence.diagnostics.counts,
            captures: 2,
          }),
        );
      }
      return true;
    });
  }
});

const focusRouteProbeState = (overrides = {}) => ({
  identity: { count: 1, sameNode: true, connected: true },
  active: true,
  focusVisible: true,
  rect: { x: 100, y: 100, width: 54, height: 30 },
  viewport: { width: 1280, height: 800, dpr: 1 },
  scroll: { x: 0, y: 0 },
  outline: { style: "solid", width: "2px", offset: "3px", color: "rgb(255, 255, 255)" },
  radii: ["11px", "11px", "11px", "11px"],
  inline: { hadStyle: false, value: "", priority: "", other: [] },
  spotlightCount: 0,
  effects: [
    {
      tag: "BUTTON",
      id: "addImportButton",
      opacity: "1",
      transform: "none",
      zoom: "1",
      clip: "auto",
      clipPath: "none",
      filter: "none",
      backdropFilter: "none",
      maskImage: "none",
      perspective: "none",
      mixBlendMode: "normal",
      visibility: "visible",
      scrollLeft: 0,
      scrollTop: 0,
    },
  ],
  ...overrides,
});

const focusRouteDecoded = (width, height) => {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([255, 255, 255, 255], offset);
  return { width, height, data: Array.from(data) };
};

const focusRouteHandle = (states) => {
  let stateIndex = 0;
  const handle = {
    evaluateCalls: [],
    disposeCalls: 0,
    async evaluate(_callback, selector) {
      this.evaluateCalls.push(selector);
      if (stateIndex >= states.length) throw new Error("focus route test 缺少探针状态");
      return states[stateIndex++];
    },
    async dispose() {
      this.disposeCalls += 1;
    },
  };
  return handle;
};

const createFocusRoutePage = ({ handle, decoded = focusRouteDecoded(72, 48) } = {}) => {
  const page = createScriptedPage(defaultHandlers());
  page.$$ = async () => [handle];
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (source, argument) => {
    if (typeof source === "function" && String(source).includes("new Image()")) return decoded;
    return evaluate(source, argument);
  };
  return page;
};

test("A61：focus.outline 走单帧 A59 路由并保留 focused-only 证据", async () => {
  const state = focusRouteProbeState();
  const handle = focusRouteHandle([state, state, state]);
  const page = createFocusRoutePage({ handle });
  const result = await measureBrowserRoles({
    page,
    candidate: null,
    mode: "light",
    stateId: "keyboard-focus",
    roleCatalog: [m32Role("focus.outline")],
    policy: M31_POLICY,
  });
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.method, "browser-focus-outline-adjacent-pixels");
  assert.equal(record.threshold, 3);
  assert.equal(record.result, "fail");
  assert.equal(record.reason, "background-contrast-below-threshold");
  assert.deepEqual(evidence.probes.before, state);
  assert.deepEqual(evidence.probes.afterFocused, state);
  assert.deepEqual(evidence.probes.afterDecode, state);
  assert.deepEqual(evidence.decoded, { width: 72, height: 48 });
  assert.equal(evidence.mutated, false);
  assert.deepEqual(evidence.captures, { focused: 0 });
  assert.equal(result.captures.length, 1);
  assert.equal(result.captures[0].kind, "focus-outline-adjacent-focused");
  assert.deepEqual(result.captures[0].clip, { x: 91, y: 91, width: 72, height: 48 });
  assert.equal(result.captures[0].dpr, 1);
  assert.deepEqual(result.captures[0].scroll, { x: 0, y: 0 });
  assert.equal(handle.disposeCalls, 1);
  assert.equal(page.evaluations.filter((tag) => tag === "scroll-begin").length, 1);
  assert.equal(page.evaluations.filter((tag) => tag === "scroll-restore").length, 1);
  assert.deepEqual(result.diagnostics.restoration.scrollDifferences, []);
  assert.equal(page.screenshots.filter((options) => options?.fullPage === false).length, 1);
});

test("A61：focus 操作失败仍保留单帧原图和 focused-only partial", async () => {
  const operationError = new Error("after focus probe failure");
  const state = focusRouteProbeState();
  let evaluateCalls = 0;
  const handle = {
    async evaluate() {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return state;
      throw operationError;
    },
    async dispose() {},
  };
  const page = createFocusRoutePage({ handle });
  await assert.rejects(
    measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId: "keyboard-focus",
      roleCatalog: [m32Role("focus.outline")],
      policy: M31_POLICY,
    }),
    (error) => {
      assert.strictEqual(error, operationError);
      assert.equal(error.focusOutlineEvidence.captures.focused.length, 8);
      assert.strictEqual(error.measurementEvidence.captures, error.focusOutlineEvidence.measurement.captures);
      assert.equal(error.measurementEvidence.captures.length, 1);
      assert.equal(error.measurementEvidence.captures[0].kind, "focus-outline-adjacent-focused");
      assert.deepEqual(error.measurementEvidence.captures[0].clip, { x: 91, y: 91, width: 72, height: 48 });
      assert.equal(error.measurementEvidence.complete, false);
      assert.equal(error.measurementEvidence.phase, "roles");
      return true;
    },
  );
  assert.equal(page.screenshots.filter((options) => options?.fullPage === false).length, 1);
});

test("A61：focus保留滚动原Error、cleanup/原始错误聚合与partial", async (t) => {
  for (const scenario of ["restore", "both", "operation", "frozen", "primitive"]) {
    const restorationError = new Error("original focus scroll restore");
    const operationError = scenario === "primitive" ? 0 : new Error("original focus operation");
    if (scenario === "frozen") Object.freeze(operationError);
    const page = createScriptedPage(
      defaultHandlers({
        "scroll-restore": () => {
          if (scenario === "restore" || scenario === "both") throw restorationError;
          return { ok: true, restored: true };
        },
      }),
    );
    page.$$ = async () => {
      if (scenario !== "restore") throw operationError;
      return [];
    };
    await assert.rejects(
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId: "keyboard-focus",
        roleCatalog: [m32Role("focus.outline")],
        policy: M31_POLICY,
      }),
      (error) => {
        if (scenario === "both") {
          assert.ok(error instanceof AggregateError);
          assert.strictEqual(error.errors[0], operationError);
          assert.strictEqual(error.errors[1], restorationError);
        } else if (scenario === "restore") {
          assert.strictEqual(error, restorationError);
        } else if (scenario === "operation") {
          assert.strictEqual(error, operationError);
        } else {
          assert.notStrictEqual(error, operationError);
          assert.strictEqual(error.cause, operationError);
        }
        assert.equal(error.focusOutlineEvidence.captures.focused, null);
        assert.strictEqual(error.measurementEvidence.captures, error.focusOutlineEvidence.measurement.captures);
        assert.equal(error.measurementEvidence.captures.length, 0);
        assert.equal(error.measurementEvidence.phase, "roles");
        assert.equal(error.measurementEvidence.complete, false);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.deepEqual(error.measurementEvidence.diagnostics.counts, {
          pass: 0,
          fail: 0,
          unmeasured: 0,
          notApplicable: 0,
        });
        if (scenario === "restore" || scenario === "both")
          assert.match(
            error.measurementEvidence.diagnostics.restoration.scrollDifferences[0],
            /original focus scroll restore/,
          );
        t.diagnostic(
          JSON.stringify({
            scenario,
            originalObjectsPreserved: true,
            phase: error?.measurementEvidence?.phase ?? null,
            complete: error?.measurementEvidence?.complete ?? null,
            captures: error?.measurementEvidence?.captures.length ?? null,
          }),
        );
        return true;
      },
    );
    assert.equal(page.evaluations.filter((tag) => tag === "scroll-restore").length, 1);
  }
});

test("D21-C5-A：非focus滚动恢复异常仍沿用诊断不抛错", async () => {
  const restoreError = new Error("legacy text scroll restore");
  const page = createScriptedPage(
    defaultHandlers({
      "scroll-restore": () => {
        throw restoreError;
      },
    }),
  );
  const result = await measureTextFixture(page);
  assert.equal(result.records.length, 1);
  assert.match(result.diagnostics.restoration.scrollDifferences[0], /legacy text scroll restore/);
  assert.equal(Object.hasOwn(result.diagnostics, "partial"), false);
  assert.deepEqual(Object.keys(result).sort(), ["captures", "diagnostics", "records"]);
});

test("M5.2.C-D8p：captureStableFullPage 原子返回原 PNG 并保留 D8m style 属性边界", async (t) => {
  for (const scenario of [
    { name: "原 style 属性缺失；新增无关声明保留", options: { addUnrelatedOnScreenshot: true }, expectedPresent: true },
    { name: "显式空 style 属性保持存在", options: { styleAttributePresent: true }, expectedPresent: true },
    {
      name: "原 gutter important 值与 priority 精确恢复",
      options: {
        styleAttributePresent: true,
        initialGutter: "auto",
        initialGutterPriority: "important",
        addUnrelatedOnScreenshot: true,
      },
      expectedPresent: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = createStableFullPageNodePage(scenario.options);
      const result = await captureStableFullPage(fixture.page);
      assert.strictEqual(result, fixture.png, "返回截图API产生的同一Buffer，不重编码");
      assert.deepEqual([fixture.state.scrollX, fixture.state.scrollY], [11, 23], "原窗口滚动恢复");
      assert.equal(fixture.style.getPropertyValue("scrollbar-gutter"), scenario.options.initialGutter ?? "");
      assert.equal(fixture.style.getPropertyPriority("scrollbar-gutter"), scenario.options.initialGutterPriority ?? "");
      assert.equal(fixture.hasStyleAttribute, scenario.expectedPresent);
      if (scenario.options.addUnrelatedOnScreenshot) {
        assert.equal(fixture.style.getPropertyValue("color"), "rgb(1, 2, 3)", "保留截图期间新增的无关声明");
      }
    });
  }
  await t.test("无 classic gutter 时不添加占位", async () => {
    const fixture = createStableFullPageNodePage({ classicGutter: 0 });
    assert.strictEqual(await captureStableFullPage(fixture.page), fixture.png);
    assert.equal(fixture.style.getPropertyValue("scrollbar-gutter"), "");
    assert.equal(fixture.hasStyleAttribute, false);
  });
});

test("M5.2.P-A25：fullPage 恢复差异保留首个字段并传入 measurement trace", async (t) => {
  const differenceOf = async (options) => {
    const fixture = createStableFullPageNodePage(options);
    let failure;
    await assert.rejects(captureStableFullPage(fixture.page), (error) => {
      assert.ok(error instanceof AggregateError);
      failure = error;
      return true;
    });
    const cleanup = failure.errors.find((error) => error.layoutDifference);
    assert.ok(cleanup, "恢复 AggregateError 必须保留有限 layoutDifference");
    return { difference: cleanup.layoutDifference, failure, fixture };
  };

  await t.test("布局相同仍返回原 Buffer", async () => {
    const fixture = createStableFullPageNodePage();
    assert.strictEqual(await captureStableFullPage(fixture.page), fixture.png);
  });

  await t.test("tooltip display 变化定位到元素字段并经过 trace 白名单", async () => {
    const { difference, failure } = await differenceOf({
      afterScreenshot: ({ tooltip }) => {
        tooltip.display = "none";
      },
    });
    const expected = {
      path: "elements[7].display",
      before: { present: true, value: "block" },
      after: { present: true, value: "none" },
      element: { index: 7, tag: "DIV", id: "usageTooltip", className: "usage-tooltip" },
    };
    assert.deepEqual(difference, expected);
    assert.deepEqual(measurementErrorTrace(failure).errors[0].layoutDifference, expected);
  });

  await t.test("tooltip rect 变化定位到实际坐标", async () => {
    const { difference } = await differenceOf({
      afterScreenshot: ({ tooltipRect }) => {
        tooltipRect.x += 2;
      },
    });
    assert.deepEqual(difference, {
      path: "elements[7].rect.x",
      before: { present: true, value: 880 },
      after: { present: true, value: 882 },
      element: { index: 7, tag: "DIV", id: "usageTooltip", className: "usage-tooltip" },
    });
  });

  for (const scenario of [
    {
      name: "仅 viewport.innerWidth 变化",
      options: {
        afterScreenshot: ({ drift }) => {
          drift.viewportInnerWidth = 1;
        },
      },
      expected: {
        path: "viewport.innerWidth",
        before: { present: true, value: 1200 },
        after: { present: true, value: 1201 },
      },
    },
    {
      name: "仅 html.clientWidth 变化",
      options: {
        afterScreenshot: ({ drift }) => {
          drift.htmlClientWidth = 1;
        },
      },
      expected: {
        path: "html.clientWidth",
        before: { present: true, value: 1185 },
        after: { present: true, value: 1186 },
      },
    },
    {
      name: "仅 scroll.x 变化",
      options: { restoredScroll: { x: 10, y: 23 } },
      expected: {
        path: "scroll.x",
        before: { present: true, value: 11 },
        after: { present: true, value: 10 },
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { difference } = await differenceOf(scenario.options);
      assert.deepEqual(difference, scenario.expected);
    });
  }
});

test("M5.2.P-A27：detail 仅使用 stable viewport，其它状态保持 fullPage", async (t) => {
  const failureOf = async (capture, options) => {
    const fixture = createStableFullPageNodePage(options);
    let failure;
    await assert.rejects(capture(fixture.page), (error) => {
      assert.ok(error instanceof AggregateError);
      failure = error;
      return true;
    });
    return failure.errors.find((error) => error.layoutDifference)?.layoutDifference;
  };

  await t.test("fullPage 隐藏 tooltip 仍触发严格恢复失败", async () => {
    const difference = await failureOf(captureStableFullPage, { fullPageHidesTooltip: true });
    assert.equal(difference.path, "elements[7].display");
    assert.deepEqual(
      { before: difference.before.value, after: difference.after.value, id: difference.element.id },
      { before: "block", after: "none", id: "usageTooltip" },
    );
  });

  await t.test("同一 mock 下 viewport 不触发 resize 并返回原 Buffer", async () => {
    const fixture = createStableFullPageNodePage({ fullPageHidesTooltip: true });
    assert.strictEqual(await captureStableViewport(fixture.page), fixture.png);
    assert.equal(fixture.tooltip.display, "block");
  });

  for (const scenario of [
    {
      name: "viewport 截图后的 DOM 几何变化仍失败",
      options: {
        afterScreenshot: ({ tooltipRect }) => {
          tooltipRect.x += 1;
        },
      },
      path: "elements[7].rect.x",
    },
    {
      name: "viewport 截图后的 scroll 恢复变化仍失败",
      options: { restoredScroll: { x: 10, y: 23 } },
      path: "scroll.x",
    },
  ]) {
    await t.test(scenario.name, async () => {
      assert.equal((await failureOf(captureStableViewport, scenario.options)).path, scenario.path);
    });
  }

  await t.test("detail before/after 选 viewport，dashboard 继续 fullPage", async () => {
    const detailFixture = createSpotlightDetailRowFixture({ target: SPOTLIGHT_DETAIL_ROW_TARGETS[0] });
    const detailResult = await detailFixture.run();
    assert.deepEqual(detailFixture.stateScreenshots, [{ fullPage: false }, { fullPage: false }]);
    assert.deepEqual(detailResult.diagnostics.restoration.statePixelScope, {
      kind: "viewport",
      width: detailFixture.dom.sandbox.window.innerWidth,
      height: detailFixture.dom.sandbox.window.innerHeight,
      scroll: { x: detailFixture.dom.sandbox.window.scrollX, y: detailFixture.dom.sandbox.window.scrollY },
    });

    const dashboardPage = createScriptedPage(defaultHandlers());
    const dashboardHarness = createMeasureFullPageHarness(dashboardPage, createStableFullPageNodePage());
    const dashboardResult = await measureBrowserRoles({
      page: dashboardHarness.page,
      candidate: null,
      mode: "light",
      stateId: "dashboard-default",
      roleCatalog: [m32Role("page.body-text")],
      policy: M31_POLICY,
    });
    assert.deepEqual(
      dashboardHarness.fullPageAttempts.map((attempt) => attempt.options),
      [{ fullPage: true }, { fullPage: true }],
    );
    assert.equal(dashboardHarness.viewportAttempts.length, 0);
    assert.deepEqual(dashboardResult.diagnostics.restoration.statePixelScope, { kind: "full-page" });
  });
});

test("M5.2.C-D8p：截图抛错后仍恢复 style/scroll，并原样抛出主异常", async () => {
  const expected = new Error("injected screenshot failure");
  const fixture = createStableFullPageNodePage({
    styleAttributePresent: true,
    initialGutter: "auto",
    initialGutterPriority: "important",
    screenshotError: expected,
  });
  await assert.rejects(captureStableFullPage(fixture.page), (error) => error === expected);
  assert.equal(fixture.style.getPropertyValue("scrollbar-gutter"), "auto");
  assert.equal(fixture.style.getPropertyPriority("scrollbar-gutter"), "important");
  assert.deepEqual([fixture.state.scrollX, fixture.state.scrollY], [11, 23]);
});

test("M5.2.C-D8p：保护布局变化或CSS不支持时拒绝截图并恢复原声明", async (t) => {
  for (const options of [{ driftOnStable: true }, { cssSupported: false }]) {
    await t.test(options.driftOnStable ? "设置保护改变内容几何" : "浏览器不支持 scrollbar-gutter", async () => {
      const fixture = createStableFullPageNodePage({
        ...options,
        initialGutter: "auto",
        initialGutterPriority: "important",
      });
      await assert.rejects(captureStableFullPage(fixture.page), /captureStableFullPage/);
      assert.equal(fixture.style.getPropertyValue("scrollbar-gutter"), "auto");
      assert.equal(fixture.style.getPropertyPriority("scrollbar-gutter"), "important");
      assert.deepEqual([fixture.state.scrollX, fixture.state.scrollY], [11, 23]);
    });
  }
});

test("M5.2.C-D8p：截图失败与恢复失败同时发生时保留并报告两种错误", async () => {
  const screenshotError = new Error("injected screenshot failure");
  const fixture = createStableFullPageNodePage({ screenshotError, failRestoreScroll: true });
  await assert.rejects(captureStableFullPage(fixture.page), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.errors[0], screenshotError);
    assert.strictEqual(error.cause, screenshotError);
    assert.ok(error.errors.some((item) => item.message.includes("injected scroll restore failure")));
    return true;
  });
});
function createHoverFixedFixture({
  node = probeNode(0),
  guard,
  scan,
  restore,
  scrollRestore,
  stateId = "button-hover",
  roleId = "button.secondary",
  guardTag = "hover-guard",
  guardState = {},
  roleOverrides = {},
} = {}) {
  let guardCalls = 0;
  let hidden = false;
  const observations = [];
  const state = {
    identityValid: true,
    reason: null,
    identityId: node.identityId,
    hovered: true,
    rect: node.rect,
    scroll: { x: 0, y: 0 },
    containers: [{ identityId: 20, connected: true, top: 0, left: 0 }],
    ...guardState,
  };
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes: [node], attemptToken: "a1" }),
      [guardTag]: (source) => {
        const observation = guard?.(++guardCalls, structuredClone(state), source) ?? structuredClone(state);
        observations.push(observation);
        return observation;
      },
      hide: () => {
        hidden = true;
        return { ok: true, token: "h1" };
      },
      restore: () => {
        hidden = false;
        return restore?.() ?? { ok: true, inlineRestored: true };
      },
      verify: () => ({ ok: true, after: afterSnapshot(node) }),
      ...(scan ? { scan } : {}),
      ...(scrollRestore ? { "scroll-restore": scrollRestore } : {}),
    }),
  );
  return {
    page,
    observations,
    get hidden() {
      return hidden;
    },
    run: () =>
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [m32Role(roleId, { ...roleOverrides, states: [stateId] })],
        policy: M31_POLICY,
      }),
  };
}

const SPOTLIGHT_METRIC_VALUE_SELECTOR = ".metric:has(> #totalTokens) > #totalTokens";

const spotlightMetricValueNode = (overrides = {}) => {
  const fullTextRect = { x: 110, y: 56, width: 96, height: 24 };
  return probeNode(0, {
    tag: "strong",
    id: "totalTokens",
    text: "1,234,567",
    client: { left: 0, top: 0, width: 180, height: 34 },
    textRects: [fullTextRect],
    rawTextRects: [fullTextRect],
    ...overrides,
  });
};

const spotlightMetricGuardState = (node, targetKind = "label") => ({
  targetIdentityId: node.identityId,
  targetConnected: true,
  targetText: node.text,
  targetColor: node.computed.color,
  targetTextFillColor: node.computed.textFillColor,
  targetTextShadow: node.computed.textShadow,
  metricTargetKind: targetKind,
  leafIsMetricLabel: targetKind === "label",
  leafIsMetricValue: targetKind === "value",
  ...(targetKind === "value"
    ? {
        targetClientWidth: node.client.width,
        targetScrollWidth: node.client.width,
        targetRangeRects: node.rawTextRects,
      }
    : {}),
  metricHostCount: 1,
  metricLabelCount: 1,
  hostIdentityId: 40,
  currentHostIdentityId: 40,
  hostSame: true,
  hostConnected: true,
  activeHostCount: 1,
  activeHostSame: true,
  hovered: true,
  targetRect: node.rect,
  hostRect: { x: 80, y: 30, width: 240, height: 60 },
  viewport: { width: 1280, height: 800, dpr: 1 },
  scroll: { x: 0, y: 0 },
  containers: [{ identityId: 20, connected: true, top: 0, left: 0 }],
  spotlight: {
    x: "120px",
    y: "30px",
    radius: "156px",
    mask: "radial-gradient(circle, black, transparent)",
    pseudo: {
      content: '""',
      opacity: "1",
      maskImage: "radial-gradient(circle, black, transparent)",
      backgroundImage: "radial-gradient(circle, rgb(1, 2, 3), transparent)",
      position: "absolute",
      inset: "0px",
      zIndex: "-1",
      borderRadius: "4px",
      pointerEvents: "none",
      mixBlendMode: "normal",
      filter: "none",
    },
    hostStyle: {
      display: "block",
      visibility: "visible",
      isolation: "isolate",
      position: "relative",
      boxShadow: "none",
      borderRadius: "4px",
    },
  },
});

const createSpotlightMetricFixture = ({ node = probeNode(0), ...overrides } = {}) =>
  createHoverFixedFixture({
    node,
    stateId: "spotlight-metric-label",
    roleId: "panel.metric-label",
    guardTag: "spotlight-metric-guard",
    guardState: spotlightMetricGuardState(node),
    roleOverrides: { selector: ".metric span" },
    ...overrides,
  });

const createSpotlightMetricValueFixture = ({ node = spotlightMetricValueNode(), ...overrides } = {}) =>
  createHoverFixedFixture({
    node,
    stateId: "spotlight-metric-label",
    roleId: "panel.metric-value",
    guardTag: "spotlight-metric-guard",
    guardState: spotlightMetricGuardState(node, "value"),
    roleOverrides: {
      selector: ".metric strong",
      selectorsByState: { "spotlight-metric-label": SPOTLIGHT_METRIC_VALUE_SELECTOR },
    },
    ...overrides,
  });

function assertHoverFixedCleanup(fixture) {
  assert.equal(fixture.hidden, false);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "restore").length, 1);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "scroll-restore").length, 1);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "release-attempt").length, 1);
  for (const tag of ["bring-into-view", "scroll-by", "scroll-to"]) {
    assert.equal(fixture.page.evaluations.includes(tag), false, tag);
  }
}

test("D21-C7-B2：悬停单目标保持固定视口、正式身份和文字方法", async () => {
  const fixture = createHoverFixedFixture();
  const result = await fixture.run();
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.candidateId, "official-source");
  assert.equal(record.roleId, "button.secondary");
  assert.equal(record.stateId, "button-hover");
  assert.equal(record.method, "browser-text-pixels");
  assert.equal(record.result, "pass");
  assert.equal(record.ratio, 21);
  const evidence = JSON.parse(record.evidence);
  assert.equal(evidence.selector, "#addImportButton:hover");
  assert.equal(evidence.nodes.length, 1);
  assert.equal(evidence.nodes[0].bands.length, 1);
  assert.deepEqual(
    result.diagnostics.hoverStateGuards.map((entry) => entry.phase),
    [
      "baseline",
      "after-hide",
      "before-png",
      "after-png",
      "after-scan",
      "after-style-restore",
      "after-verify",
      "after-scroll-restore",
    ],
  );
  assert.ok(result.diagnostics.hoverStateGuards.every((entry) => entry.valid));
  assertHoverFixedCleanup(fixture);
});

test("D21-C7-B2：采样悬停丢失随后重入仍拒绝，保留实际PNG和partial", async () => {
  const fixture = createHoverFixedFixture({ guard: (call, state) => ({ ...state, hovered: call !== 4 }) });
  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.message, /after-png/);
    const partial = error.measurementEvidence;
    assert.equal(partial.complete, false);
    assert.equal(partial.phase, "roles");
    assert.deepEqual(partial.records, []);
    assert.equal(partial.captures.length, 1);
    assert.equal(partial.captures[0].pngBase64, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"));
    assert.ok(partial.diagnostics.hoverStateGuards.some((entry) => !entry.valid));
    assert.equal(partial.diagnostics.hoverStateGuards.at(-1).observed.hovered, true);
    return true;
  });
  assertHoverFixedCleanup(fixture);
});

test("D21-C7-B2：hover为真但几何、窗口或容器滚动漂移仍拒绝", async (t) => {
  for (const kind of ["rect", "window", "container", "identity"]) {
    await t.test(kind, async () => {
      const fixture = createHoverFixedFixture({
        guard: (call, state) => {
          if (call === 5) {
            if (kind === "rect") state.rect.y += 1;
            if (kind === "window") state.scroll.y += 1;
            if (kind === "container") state.containers[0].top += 1;
            if (kind === "identity") state.identityValid = false;
          }
          return state;
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-scan/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 1);
        return true;
      });
      assertHoverFixedCleanup(fixture);
    });
  }
});

// ============================================================================
// D. 原生命中遮挡组件（D21-C8-D3a）：真实页内守卫 + 最小 CDP 协议替身。
//    替身只按协议返回原始对象、帧与 backendNodeId，命中判定由生产页内源在真 DOM
//    替身里执行——测试不复制命中算法，也不重算五点公式。
// ============================================================================

const NATIVE_OCCLUSION_SELECTOR = ".quota-preset-status";
const NATIVE_OCCLUSION_TEXT = "5 小时限额：尚未发现 Codex 限额记录。";
const NATIVE_OCCLUSION_RECT = Object.freeze({ x: 600, y: 500, width: 200, height: 20 });
const NATIVE_OCCLUSION_GROUP = "skin-palette-toast-native-occlusion";
const NATIVE_OCCLUSION_KINDS = ["center", "topLeft", "topRight", "bottomLeft", "bottomRight"];

function createNativeOcclusionDom({ rect, descendant = false }) {
  const dom = createElementStubDom();
  dom.sandbox.performance = { now: () => 0 };
  const host = dom.build({
    selector: NATIVE_OCCLUSION_SELECTOR,
    id: "quotaPresetStatus",
    className: "quota-preset-status",
    tag: "SPAN",
    rect,
    descendants: descendant ? [{ tag: "SPAN", id: "toast-text", className: "toast-text", rect }] : [],
  });
  host.isConnected = true;
  host.textContent = NATIVE_OCCLUSION_TEXT;
  return { dom, host, text: descendant ? host._descendants[0] : null };
}

/** 最小 CDP 协议替身：只提供原始对象/帧/backendNodeId；命中比较交回生产页内函数。 */
function createNativeOcclusionSession({
  dom,
  host,
  nativeHits,
  overrides = {},
  hooks = {},
  releaseError = null,
  detachError = null,
}) {
  const calls = [];
  const hostFetches = [];
  const elementByObjectId = new Map([["host-object", host]]);
  const backendByElement = new Map();
  let lookups = 0;
  let detachCalls = 0;
  return {
    calls,
    hostFetches,
    get detachCalls() {
      return detachCalls;
    },
    async send(method, params) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === "Runtime.evaluate") {
        // 原宿主对象只能从原 attempt 表达式取出：替身不按同 id 另找节点
        const element = runInNewContext(String(params.expression), dom.sandbox);
        hostFetches.push(element);
        elementByObjectId.set("host-object", element);
        return { result: { objectId: "host-object" } };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "DOM.getNodeForLocation") {
        hooks.beforePoint?.(lookups);
        const element = nativeHits[lookups++];
        if (!element) return {};
        if (!backendByElement.has(element)) backendByElement.set(element, backendByElement.size + 1);
        const backendNodeId = backendByElement.get(element);
        elementByObjectId.set(`hit-${backendNodeId}`, element);
        return { backendNodeId, frameId: "main-frame" };
      }
      if (method === "DOM.resolveNode") {
        const element = [...backendByElement.entries()].find(([, id]) => id === params.backendNodeId)?.[0];
        return element ? { object: { objectId: `hit-${params.backendNodeId}` } } : {};
      }
      if (method === "Runtime.callFunctionOn") {
        // 执行的是生产发来的真实命中声明；替身不做 contains/withinHost 判读
        const declaration = runInNewContext(`(${params.functionDeclaration})`, dom.sandbox);
        const self = elementByObjectId.get(params.objectId);
        const hit = elementByObjectId.get(params.arguments?.[0]?.objectId);
        return { result: { value: hostValue(declaration.call(self, hit)) } };
      }
      if (method === "Runtime.releaseObjectGroup") {
        if (releaseError) throw releaseError;
        return {};
      }
      throw new Error(`原生测试替身未实现 ${method}`);
    },
    async detach() {
      calls.push({ method: "detach" });
      detachCalls += 1;
      if (detachError) throw detachError;
    },
  };
}

function createNativeOcclusionPage(dom, session) {
  const created = [];
  return {
    created,
    async evaluate(source) {
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      if (tag !== "native-occlusion-guard") throw new TypeError(`原生测试替身未实现页内源 ${String(tag)}`);
      return hostValue(runInNewContext(String(source), dom.sandbox));
    },
    context() {
      return {
        newCDPSession: async (target) => {
          created.push(target);
          return session;
        },
      };
    },
  };
}

function createNativeOcclusionFixture({
  rect = null,
  descendant = false,
  overlay = null,
  scroll = { x: 0, y: 0 },
  overrides,
  hooks,
  releaseError,
  detachError,
} = {}) {
  const rectValue = rect ?? { ...NATIVE_OCCLUSION_RECT };
  const { dom, host, text } = createNativeOcclusionDom({ rect: rectValue, descendant });
  dom.sandbox.window.scrollX = scroll.x;
  dom.sandbox.window.scrollY = scroll.y;
  let overlayElement = null;
  if (overlay) {
    overlayElement = dom.build({ selector: ".overlay", id: "overlay", className: "overlay", rect: rectValue });
    // pointer-events:none 的覆盖层会被默认命中跳过；原生 CDP(ignorePointerEventsNone) 不跳过
    dom.setHitTest(() => (overlay.pointerEvents === "auto" ? overlayElement : host));
  } else {
    const isCenter = (x, y) => x === rectValue.x + rectValue.width / 2 && y === rectValue.y + rectValue.height / 2;
    dom.setHitTest((x, y) => (text && isCenter(x, y) ? text : host));
  }
  const attempt = hostValue(
    runInNewContext(buildProbeSource("node-probe", NATIVE_OCCLUSION_SELECTOR, null, null, true), dom.sandbox),
  );
  const hide = hostValue(
    runInNewContext(buildProbeSource("hide", NATIVE_OCCLUSION_SELECTOR, 0, "text", attempt.attemptToken), dom.sandbox),
  );
  const pointerProbe = hostValue(
    runInNewContext(
      buildProbeSource("occlusion-probe", NATIVE_OCCLUSION_SELECTOR, 0, [rectValue], hide.token),
      dom.sandbox,
    ),
  );
  assert.equal(attempt.nodes.length, 1, "替身自检：单一原始宿主");
  assert.equal(hide.ok, true, "替身自检：隐藏样本已建立");
  assert.equal(pointerProbe.identityValid, true, "替身自检：原遮挡探针身份有效");
  // 原生命中命中面：覆盖层全遮挡；否则中心落后代、四角落宿主自身
  const nativeHits = NATIVE_OCCLUSION_KINDS.map((_, index) =>
    overlayElement ? overlayElement : index === 0 && text ? text : host,
  );
  const session = createNativeOcclusionSession({
    dom,
    host,
    overrides,
    hooks,
    releaseError,
    detachError,
    nativeHits,
  });
  const page = createNativeOcclusionPage(dom, session);
  return {
    dom,
    host,
    text,
    overlay: overlayElement,
    rect: rectValue,
    attemptToken: attempt.attemptToken,
    hiddenToken: hide.token,
    pointerProbe,
    session,
    page,
    run: (options = {}) =>
      probeToastNativeOcclusion({
        page,
        attemptToken: attempt.attemptToken,
        hiddenToken: hide.token,
        rects: [rectValue],
        pointerProbe,
        ...options,
      }),
  };
}

const assertNativeOcclusionCleanup = (fixture) => {
  const releases = fixture.session.calls.filter((call) => call.method === "Runtime.releaseObjectGroup");
  assert.equal(releases.length, 1, "对象组释放一次");
  assert.deepEqual(releases[0].params, { objectGroup: NATIVE_OCCLUSION_GROUP });
  assert.equal(fixture.session.detachCalls, 1, "CDP 会话分离一次");
  const order = fixture.session.calls.map((call) => call.method).filter((method) => method !== "Runtime.evaluate");
  assert.ok(order.indexOf("Runtime.releaseObjectGroup") < order.indexOf("detach"), "先释放对象组再分离会话");
};

test("D21-C8-D3a：原宿主与后代命中返回有界结果，复用原五点坐标并释放会话", async () => {
  const fixture = createNativeOcclusionFixture({ descendant: true });
  const result = await fixture.run();

  assert.equal(result.identityValid, true);
  assert.equal(result.source, "native-cdp");
  assert.deepEqual(result.scroll, { x: 0, y: 0 });
  assert.equal(result.rects.length, 1);
  assert.equal(result.rects[0].rectIndex, 0);
  const points = result.rects[0].points;
  assert.deepEqual(
    points.map((point) => point.kind),
    NATIVE_OCCLUSION_KINDS,
  );
  // 坐标必须原样来自 buildOcclusionProbeSource 的结果，不重算五点公式
  assert.deepEqual(
    points.map((point) => [point.x, point.y]),
    fixture.pointerProbe.rects[0].points.map((point) => [point.x, point.y]),
  );
  const nativeDocumentCalls = fixture.session.calls
    .filter((call) => call.method === "DOM.getNodeForLocation")
    .map((call) => [call.params.x, call.params.y]);
  assert.deepEqual(
    nativeDocumentCalls,
    points.map((point) => [point.integer.x, point.integer.y]),
    "scroll=0 时 native document 整数坐标与 viewport 整数坐标相同",
  );
  assert.deepEqual(
    points.map((point) => point.coordinates),
    points.map((point) => ({
      viewport: { x: point.x, y: point.y },
      viewportInteger: { x: point.integer.x, y: point.integer.y },
      scroll: { x: 0, y: 0 },
      nativeDocumentInteger: { x: point.integer.x, y: point.integer.y },
    })),
    "结果同时保留 viewport 与 native document 坐标",
  );
  assert.deepEqual(
    points.map((point) => [point.defaultHit.x, point.defaultHit.y]),
    points.map((point) => [point.integer.x, point.integer.y]),
    "scroll=0 时 elementFromPoint 仍使用 viewport 整数点",
  );
  assert.ok(
    fixture.session.calls
      .filter((call) => call.method === "DOM.getNodeForLocation")
      .every((call) => call.params.ignorePointerEventsNone === true),
  );
  // 中心命中后代（contains），四角命中宿主自身（identity）
  assert.equal(points[0].withinHost, true);
  assert.equal(points[0].top.tag, "span");
  assert.equal(points[0].top.id, "toast-text");
  for (const point of points.slice(1)) {
    assert.equal(point.withinHost, true, point.kind);
    assert.equal(point.top.id, "quotaPresetStatus");
  }
  assert.ok(points.every((point) => point.source === "native-cdp" && point.frameId === "main-frame"));
  assert.ok(points.every((point) => Number.isInteger(point.backendNodeId) && point.backendNodeId > 0));
  assert.ok(points.every((point) => point.hostMatch.connected === true && point.hostMatch.withinHost === true));
  assert.deepEqual(
    points.map((point) => point.defaultHit.withinHost),
    [true, true, true, true, true],
  );
  assert.equal(points[0].defaultHit.top.identityId, points[0].top.identityId);
  assert.equal(result.host.attemptToken, "a1");
  assert.equal(result.host.hiddenToken, fixture.hiddenToken);
  assert.equal(result.host.selector, NATIVE_OCCLUSION_SELECTOR);
  assert.equal(result.host.connected, true);
  assert.ok(Number.isInteger(result.host.identityId));
  assert.deepEqual(result.frame, { main: "main-frame" });
  assert.equal("ratio" in result, false, "本组件不输出文字比值判读");
  assert.ok(points.every((point) => !("ratio" in point) && !("result" in point)));
  assert.deepEqual(
    result.checkpoints.map((entry) => entry.label),
    ["baseline", ...NATIVE_OCCLUSION_KINDS.map((kind) => `after:${kind}`), "after"],
  );
  // 原宿主对象确实来自原 attempt[0]，且对象组复用自己的固定名字
  const evaluate = fixture.session.calls.find((call) => call.method === "Runtime.evaluate");
  assert.equal(evaluate.params.expression, `window["__skinPaletteMeasurementStash"].attempts.get("a1").elements[0]`);
  assert.equal(evaluate.params.objectGroup, NATIVE_OCCLUSION_GROUP);
  assert.strictEqual(fixture.session.hostFetches[0], fixture.host);
  assertNativeOcclusionCleanup(fixture);
});

test("A53：非零整数已守卫滚动只平移 native document 请求", async () => {
  const scroll = { x: 13, y: 28 };
  const fixture = createNativeOcclusionFixture({ scroll });
  const result = await fixture.run();
  const points = result.rects[0].points;
  const nativeCalls = fixture.session.calls
    .filter((call) => call.method === "DOM.getNodeForLocation")
    .map((call) => [call.params.x, call.params.y]);
  const expectedNative = points.map((point) => [point.integer.x + scroll.x, point.integer.y + scroll.y]);

  assert.deepEqual(result.scroll, scroll);
  assert.deepEqual(nativeCalls, expectedNative);
  assert.ok(nativeCalls.flat().every(Number.isSafeInteger));
  assert.ok(
    nativeCalls.some(([x, y], index) => x !== points[index].integer.x || y !== points[index].integer.y),
    "非零 scroll 必须让 native 请求离开 viewport 原点",
  );
  assert.deepEqual(
    points.map((point) => [point.defaultHit.x, point.defaultHit.y]),
    points.map((point) => [point.integer.x, point.integer.y]),
    "DOM elementFromPoint 的 defaultHit 继续保持 viewport 坐标",
  );
  for (const point of points) {
    assert.deepEqual(point.coordinates, {
      viewport: { x: point.x, y: point.y },
      viewportInteger: { x: point.integer.x, y: point.integer.y },
      scroll,
      nativeDocumentInteger: {
        x: point.integer.x + scroll.x,
        y: point.integer.y + scroll.y,
      },
    });
  }
  assertNativeOcclusionCleanup(fixture);
});

test("A53：fractional 已守卫滚动不能精确转成安全 document 整数时拒绝", async () => {
  const fixture = createNativeOcclusionFixture({ scroll: { x: 13.4, y: 27.6 } });
  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.message, /不能精确转换为安全 document 整数/);
    const current = error.toastOcclusionEvidence.currentPoint;
    assert.equal(current.kind, "center");
    assert.ok(Number.isSafeInteger(current.viewportInteger.x) && Number.isSafeInteger(current.viewportInteger.y));
    assert.deepEqual(current.scroll, { x: 13.4, y: 27.6 });
    assert.deepEqual(current.nativeDocument, {
      x: current.viewportInteger.x + 13.4,
      y: current.viewportInteger.y + 27.6,
    });
    return true;
  });
  assert.equal(
    fixture.session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length,
    0,
    "无精确整数坐标时不查询近似点，也不改试另一坐标",
  );
  assertNativeOcclusionCleanup(fixture);
});

test("D21-C8-D3a：三类外部覆盖均在宿主之外，并阻断原文字测量", async (t) => {
  const flavors = [
    { name: "auto/opaque", pointerEvents: "auto", defaultWithinHost: false },
    { name: "none/opaque", pointerEvents: "none", defaultWithinHost: true },
    { name: "none/translucent", pointerEvents: "none", defaultWithinHost: true },
  ];
  for (const flavor of flavors) {
    await t.test(flavor.name, async () => {
      const fixture = createNativeOcclusionFixture({ overlay: { pointerEvents: flavor.pointerEvents } });
      const result = await fixture.run();
      const points = result.rects[0].points;
      assert.ok(
        points.every((point) => point.withinHost === false),
        "原生命中不因 pointer-events/半透明放行",
      );
      assert.ok(points.every((point) => point.top.id === "overlay"));
      assert.ok(points.every((point) => point.defaultHit.withinHost === flavor.defaultWithinHost));
      assertNativeOcclusionCleanup(fixture);

      // 把 helper 结果喂回原文字路径：拒绝必须由原 occlusionFailureReason 得出
      const page = createScriptedPage(
        defaultHandlers({
          "node-probe": () => ({ nodes: [probeNode(0)], attemptToken: "attempt-native-overlay" }),
          "occlusion-probe": () => result,
        }),
      );
      const measured = await measureTextFixture(page);
      assert.equal(measured.records[0].result, "unmeasured");
      assert.match(measured.records[0].reason, /宿主及其后代之外的命中/);
      assert.match(measured.records[0].reason, /div#overlay/);
      assert.equal(measured.captures.length, 0, "被遮挡 band 不生成背景截图");
      assert.equal(page.evaluations.includes("scan"), false);
    });
  }
});

test("D21-C8-D3a：替换同 id 节点与错配隐藏样本都不被接受，且不按同 id 另找对象", async (t) => {
  const assertNeverLookedUp = (fixture) => {
    assert.equal(
      fixture.session.calls.filter((call) => call.method === "Runtime.evaluate").length,
      0,
      "不取原宿主 CDP 对象",
    );
    assert.equal(
      fixture.session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length,
      0,
      "不做命中查询",
    );
    assertNativeOcclusionCleanup(fixture);
  };
  await t.test("同 id 替换节点", async () => {
    const fixture = createNativeOcclusionFixture();
    const replacement = fixture.dom.build({
      selector: NATIVE_OCCLUSION_SELECTOR,
      id: "quota-preset-status",
      tag: "DIV",
      rect: { ...NATIVE_OCCLUSION_RECT },
    });
    fixture.dom.replace(fixture.host, replacement);
    await assert.rejects(fixture.run(), /第 0 位已换成新节点/);
    assertNeverLookedUp(fixture);
  });
  await t.test("隐藏样本属于另一次尝试", async () => {
    const fixture = createNativeOcclusionFixture();
    const other = fixture.dom.build({
      selector: ".other-toast",
      id: "other-toast",
      tag: "DIV",
      rect: { ...NATIVE_OCCLUSION_RECT },
    });
    other.isConnected = true;
    other.textContent = NATIVE_OCCLUSION_TEXT;
    const otherAttempt = runInNewContext(
      buildProbeSource("node-probe", ".other-toast", null, null, true),
      fixture.dom.sandbox,
    );
    const otherHide = hostValue(
      runInNewContext(
        buildProbeSource("hide", ".other-toast", 0, "text", otherAttempt.attemptToken),
        fixture.dom.sandbox,
      ),
    );
    await assert.rejects(fixture.run({ hiddenToken: otherHide.token }), /隐藏样本不属于本次角色尝试/);
    assertNeverLookedUp(fixture);
  });
  await t.test("隐藏样本不存在", async () => {
    const fixture = createNativeOcclusionFixture();
    await assert.rejects(fixture.run({ hiddenToken: "h-missing" }), /隐藏样本暂存不存在/);
    assertNeverLookedUp(fixture);
  });
});

test("D21-C8-D3a：宿主范围必须仍是原 toast 的 span/id/class", async (t) => {
  const cases = [
    ["错误标签", (fixture) => (fixture.host.tagName = "DIV"), /宿主标签不是原toast的 SPAN/],
    ["错误 id", (fixture) => (fixture.host.id = "quota-preset-status"), /宿主 id 不是原toast的 quotaPresetStatus/],
    ["缺少 class", (fixture) => (fixture.host.className = ""), /宿主缺少原toast的 quota-preset-status class/],
  ];
  for (const [label, mutate, pattern] of cases) {
    await t.test(label, async () => {
      const fixture = createNativeOcclusionFixture();
      mutate(fixture);
      await assert.rejects(fixture.run(), pattern);
      assert.equal(
        fixture.session.calls.filter((call) => call.method === "Runtime.evaluate").length,
        0,
        "范围不符不取原宿主 CDP 对象",
      );
      assert.equal(
        fixture.session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length,
        0,
        "范围不符不做命中查询",
      );
      assertNativeOcclusionCleanup(fixture);
    });
  }
});

test("D21-C8-D3a：当前完整文字矩形必须与传入采样矩形一致", async (t) => {
  await t.test("实际文字移位但传入旧矩形", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._textRects = [{ x: 100, y: 100, width: 50, height: 20 }];
    await assert.rejects(fixture.run(), /与传入采样矩形不一致/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("增加第二行", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._textRects = [
      { ...fixture.rect },
      { x: fixture.rect.x, y: fixture.rect.y + 24, width: 100, height: 20 },
    ];
    await assert.rejects(fixture.run(), /不是单一矩形/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("仅取子矩形", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._textRects = [
      { x: fixture.rect.x + 10, y: fixture.rect.y + 2, width: fixture.rect.width / 2, height: fixture.rect.height - 4 },
    ];
    await assert.rejects(fixture.run(), /与传入采样矩形不一致/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("正常分数坐标仍按原五点量化", async () => {
    const fixture = createNativeOcclusionFixture({
      rect: { x: 600.4, y: 500.6, width: 199.2, height: 20.8 },
    });
    const result = await fixture.run();
    assert.equal(result.identityValid, true);
    const points = result.rects[0].points;
    assert.deepEqual(
      points.map((point) => [point.x, point.y]),
      fixture.pointerProbe.rects[0].points.map((point) => [point.x, point.y]),
    );
    assert.deepEqual(
      fixture.session.calls
        .filter((call) => call.method === "DOM.getNodeForLocation")
        .map((call) => [call.params.x, call.params.y]),
      points.map((point) => [Math.round(point.x), Math.round(point.y)]),
    );
    assertNativeOcclusionCleanup(fixture);
  });
});

test("D21-C8-D3a：已知不支持的绘制边界保守拒绝，普通 box-shadow 仍可测", async (t) => {
  await t.test("宿主自身 filter", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._computed.filter = "blur(3px)";
    await assert.rejects(fixture.run(), /filter=blur\(3px\)/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("祖先整体透明度", async () => {
    const fixture = createNativeOcclusionFixture();
    const parent = fixture.dom.build({
      tag: "DIV",
      id: "toast-layer",
      rect: { ...NATIVE_OCCLUSION_RECT },
      computed: { opacity: "0.5" },
    });
    fixture.host.parentElement = parent;
    await assert.rejects(fixture.run(), /opacity=0.5/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("伪元素生成内容", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._pseudo = { content: '"x"' };
    await assert.rejects(fixture.run(), /伪元素绘制/);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("普通 box-shadow 仍是支持形态", async () => {
    const fixture = createNativeOcclusionFixture();
    fixture.host._computed.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.2)";
    const result = await fixture.run();
    assert.equal(result.identityValid, true);
    assertNativeOcclusionCleanup(fixture);
  });
});

test("D21-C8-D3a：帧、对象、协议返回与坐标不符一律失败并清理会话", async (t) => {
  const cases = [
    ["帧不是主帧", { "DOM.getNodeForLocation": () => ({ backendNodeId: 1, frameId: "child-frame" }) }, /不是主帧/],
    ["backendNodeId 无效", { "DOM.getNodeForLocation": () => ({}) }, /未返回有效 backendNodeId/],
    ["节点未解析为对象", { "DOM.resolveNode": () => ({ object: {} }) }, /未能解析为对象/],
    ["命中比较异常", { "Runtime.callFunctionOn": () => ({ exceptionDetails: { text: "boom" } }) }, /命中比较抛出异常/],
    [
      "命中比较返回无效结果",
      { "Runtime.callFunctionOn": () => ({ result: { value: { withinHost: "yes", hostConnected: true } } }) },
      /命中比较返回无效结果/,
    ],
    [
      "比较期间宿主脱离",
      { "Runtime.callFunctionOn": () => ({ result: { value: { withinHost: true, hostConnected: false } } }) },
      /比较期间原宿主已脱离文档/,
    ],
    [
      "命中节点身份无效",
      {
        "Runtime.callFunctionOn": () => ({
          result: { value: { withinHost: true, hostConnected: true, top: { identityId: "x", tag: "div" } } },
        }),
      },
      /命中节点身份无效/,
    ],
    [
      "无法取得原宿主对象",
      { "Runtime.evaluate": () => ({ exceptionDetails: { text: "no object" } }) },
      /无法取得原宿主的 CDP 对象/,
    ],
    ["无法取得主帧 id", { "Page.getFrameTree": () => ({}) }, /无法取得主帧 id/],
  ];
  for (const [label, overrides, pattern] of cases) {
    await t.test(label, async () => {
      const fixture = createNativeOcclusionFixture({ overrides });
      await assert.rejects(fixture.run(), pattern);
      assertNativeOcclusionCleanup(fixture);
    });
  }
  await t.test("坐标取整后越出当前视口", async () => {
    const fixture = createNativeOcclusionFixture({ rect: { x: 600, y: 788, width: 200, height: 20 } });
    await assert.rejects(fixture.run(), /越出当前视口/);
    assert.equal(
      fixture.session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length,
      0,
      "点位不可用时不进入原生命中",
    );
    assertNativeOcclusionCleanup(fixture);
  });
  for (const [label, context] of [
    ["context 无 newCDPSession", () => ({})],
    ["context 缺失", () => null],
  ]) {
    await t.test(label, async () => {
      const fixture = createNativeOcclusionFixture();
      await assert.rejects(fixture.run({ page: { evaluate: async () => ({}), context } }), /newCDPSession 不可用/);
      assert.equal(fixture.page.created.length, 0);
      assert.equal(fixture.session.calls.length, 0);
    });
  }
});

test("D21-C8-D3a：输入或点位不合法时在建立会话前明确失败", async (t) => {
  const cases = [
    ["多矩形", (fixture) => ({ rects: [fixture.rect, fixture.rect] }), /仅支持单一文字矩形/],
    ["缺少原探针结果", () => ({ pointerProbe: null }), /缺少 buildOcclusionProbeSource 的原结果/],
    [
      "原探针报错",
      (fixture) => ({ pointerProbe: { ...fixture.pointerProbe, error: "probe failed" } }),
      /原遮挡探针错误/,
    ],
    [
      "原探针身份未确认",
      (fixture) => ({ pointerProbe: { ...fixture.pointerProbe, identityValid: false } }),
      /身份未确认/,
    ],
    ["原探针矩形缺失", (fixture) => ({ pointerProbe: { ...fixture.pointerProbe, rects: [] } }), /单一矩形五点/],
    [
      "原探针滚动不完整",
      (fixture) => ({ pointerProbe: { ...fixture.pointerProbe, scroll: { x: Number.NaN, y: 0 } } }),
      /滚动信息不完整/,
    ],
    [
      "取整后越出原文字矩形",
      (fixture) => {
        const probe = structuredClone(fixture.pointerProbe);
        probe.rects[0].points[0].x = fixture.rect.x + fixture.rect.width + 0.4;
        return { pointerProbe: probe };
      },
      /取整后越出原文字矩形/,
    ],
    ["空 token", () => ({ attemptToken: "" }), /必须是非空字符串/],
    ["page 不具备评估能力", () => ({ page: null }), /page 需要具备 evaluate 与 context/],
  ];
  for (const [label, patch, pattern] of cases) {
    await t.test(label, async () => {
      const fixture = createNativeOcclusionFixture();
      await assert.rejects(fixture.run(patch(fixture)), pattern);
      assert.equal(fixture.page.created.length, 0, "校验失败不建立 CDP 会话");
      assert.equal(fixture.session.calls.length, 0);
    });
  }
});

test("D21-C8-D3a：调用中文字、可见性、几何、滚动或原节点变化均拒绝", async (t) => {
  const cases = [
    ["文字清空", (fixture) => (fixture.host.textContent = ""), /原生命中检查失败（after:topLeft）：宿主没有文字/],
    [
      "可见性隐藏",
      (fixture) => (fixture.host._computed.visibility = "hidden"),
      /原生命中检查失败（after:topLeft）：宿主当前不可见/,
    ],
    [
      "宿主滤镜由 none 变为 blur",
      (fixture) => (fixture.host._computed.filter = "blur(3px)"),
      /原生命中检查失败（after:topLeft）：span 的 filter=blur\(3px\)/,
    ],
    ["宿主几何漂移", (fixture) => (fixture.rect.y += 1), /检查点漂移（after:topLeft）：rect 与基线不一致/],
    [
      "滚动漂移",
      (fixture) => (fixture.dom.sandbox.window.scrollY = 3),
      /检查点漂移（after:topLeft）：scroll 与基线不一致/,
    ],
    [
      "宿主被替换",
      (fixture) =>
        fixture.dom.replace(
          fixture.host,
          fixture.dom.build({
            selector: NATIVE_OCCLUSION_SELECTOR,
            id: "quota-preset-status",
            tag: "DIV",
            rect: { ...NATIVE_OCCLUSION_RECT },
          }),
        ),
      /第 0 位已换成新节点/,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    await t.test(label, async () => {
      let fixture;
      fixture = createNativeOcclusionFixture({
        hooks: {
          beforePoint: (index) => {
            if (index === 1) mutate(fixture);
          },
        },
      });
      await assert.rejects(fixture.run(), pattern);
      assertNativeOcclusionCleanup(fixture);
    });
  }
});

test("A53：非零基线滚动在 native 检查期间漂移仍拒绝", async () => {
  let fixture;
  fixture = createNativeOcclusionFixture({
    scroll: { x: 13, y: 28 },
    hooks: {
      beforePoint: (index) => {
        if (index === 1) fixture.dom.sandbox.window.scrollX += 1;
      },
    },
  });
  await assert.rejects(fixture.run(), /检查点漂移（after:topLeft）：scroll 与基线不一致/);
  assert.equal(
    fixture.session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length,
    2,
    "漂移在第二点命中后立即拒绝，不改用另一坐标重试",
  );
  assertNativeOcclusionCleanup(fixture);
});

test("D21-C8-D3a：主错与清理错保留原始对象、顺序与 cause，冻结错不换对象", async (t) => {
  await t.test("主错与释放、分离双错并存", async () => {
    const primary = new Error("cdp hit failure");
    const releaseError = new Error("release failed");
    const detachError = new Error("detach failed");
    const fixture = createNativeOcclusionFixture({
      overrides: {
        "DOM.getNodeForLocation": () => {
          throw primary;
        },
      },
      releaseError,
      detachError,
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /原生命中组件失败且 CDP 清理也失败/);
      assert.strictEqual(error.errors[0], primary);
      assert.strictEqual(error.errors[1], releaseError);
      assert.strictEqual(error.errors[2], detachError);
      assert.strictEqual(error.cause, primary);
      assert.equal(primary.toastOcclusionEvidence.stage, "native:center");
      assert.equal(Object.getOwnPropertyDescriptor(primary, "toastOcclusionEvidence").enumerable, false);
      return true;
    });
  });
  await t.test("成功但清理失败不返回可信命中", async () => {
    const releaseError = new Error("release failed");
    const fixture = createNativeOcclusionFixture({ releaseError });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /清理失败，不返回可信命中/);
      assert.deepEqual(error.errors, [releaseError]);
      assert.equal(error.toastOcclusionEvidence.stage, "guard:after");
      assert.equal(fixture.session.detachCalls, 1);
      return true;
    });
  });
  await t.test("原始 0 主错原样抛出", async () => {
    const fixture = createNativeOcclusionFixture({
      overrides: {
        "DOM.getNodeForLocation": () => {
          throw 0;
        },
      },
    });
    await assert.rejects(fixture.run(), (error) => error === 0);
    assertNativeOcclusionCleanup(fixture);
  });
  await t.test("原始 0 主错与清理错并存", async () => {
    const releaseError = new Error("release failed");
    const fixture = createNativeOcclusionFixture({
      overrides: {
        "DOM.getNodeForLocation": () => {
          throw 0;
        },
      },
      releaseError,
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], 0);
      assert.strictEqual(error.errors[1], releaseError);
      assert.strictEqual(error.cause, 0);
      return true;
    });
  });
  await t.test("冻结错误原样抛出，不被诊断替换", async () => {
    const frozen = Object.freeze(new Error("frozen host"));
    const fixture = createNativeOcclusionFixture({
      overrides: {
        "Page.getFrameTree": () => {
          throw frozen;
        },
      },
    });
    await assert.rejects(fixture.run(), (error) => error === frozen);
    assert.equal(Object.hasOwn(frozen, "toastOcclusionEvidence"), false);
    assertNativeOcclusionCleanup(fixture);
  });
});

// ============================================================================
// E. toast 文字接线（D21-C8-D3b）：真实 measureBrowserRoles → toast 路由 →
//    真实原生命中 helper → 背景/扫描 → 恢复。页内业务守卫与原生检查按阶段留证；
//    替身只提供 DOM/CDP 原语，命中判定与对比度计算都走生产函数。
// ============================================================================

const TOAST_GUARD_PHASES = [
  "baseline",
  "after-hide",
  "before-png",
  "after-png",
  "after-scan",
  "after-style-restore",
  "after-verify",
  "after-scroll-restore",
];
const TOAST_DOM_TAGS = new Set([
  "node-probe",
  "hide",
  "restore",
  "verify",
  "occlusion-probe",
  "native-occlusion-guard",
  "toast-guard",
  "scroll-begin",
  "scroll-restore",
  "release-attempt",
  "bring-into-view",
  "scroll-by",
  "scroll-to",
]);
const TOAST_ROUTE = {
  stateId: "quota-toast",
  roleId: "toast.quota-status",
  selector: ".quota-preset-status",
};

function createToastRoutingFixture({
  sessionHits,
  onToastGuard,
  scrollRestore,
  styleRestore,
  sessionPlan,
  hostComputed,
} = {}) {
  const dom = createElementStubDom();
  dom.sandbox.performance = { now: () => 0 };
  const rect = { ...NATIVE_OCCLUSION_RECT };
  const host = dom.build({
    selector: NATIVE_OCCLUSION_SELECTOR,
    id: "quotaPresetStatus",
    className: "quota-preset-status",
    tag: "SPAN",
    rect,
    inline: { color: "rgb(255, 255, 255)" },
    ...(hostComputed ? { computed: hostComputed } : {}),
  });
  host.isConnected = true;
  host.textContent = NATIVE_OCCLUSION_TEXT;
  const body = dom.build({ selector: "body", tag: "BODY", rect: { x: 0, y: 0, width: 1280, height: 800 } });
  body.isConnected = true;
  // 默认命中面故意落在 BODY：普通 pointerProbe 认为被外部覆盖，原生探针命中原宿主。
  dom.setHitTest(() => body);

  const sessions = [];
  let guardCalls = 0;
  const base = createScriptedPage(
    defaultHandlers({
      scan: () => scanResult([["text-0-0", [0, 0, 0, 255]]]),
      ...(scrollRestore ? { "scroll-restore": scrollRestore } : {}),
      ...(styleRestore ? { restore: styleRestore } : {}),
    }),
  );
  const page = {
    evaluations: base.evaluations,
    screenshots: base.screenshots,
    initScripts: base.initScripts,
    fullPageFixture: base.fullPageFixture,
    async evaluate(source, argument) {
      if (typeof source === "function") return base.evaluate(source, argument);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      if (TOAST_DOM_TAGS.has(tag)) {
        if (tag === "toast-guard") {
          guardCalls += 1;
          onToastGuard?.(guardCalls);
        }
        // 注入的滚动恢复失败按 C7 的 handler 口径触发：真实页内源在这个替身里不会失败。
        if (tag === "scroll-restore" && typeof scrollRestore === "function") {
          return base.evaluate(source, argument);
        }
        // 注入的样式恢复失败同理：R1 用来同时制造“操作错 + 样式/滚动收尾错”。
        if (tag === "restore" && typeof styleRestore === "function") {
          return base.evaluate(source, argument);
        }
        base.evaluations.push(tag);
        return hostValue(runInNewContext(String(source), dom.sandbox));
      }
      return base.evaluate(source, argument);
    },
    screenshot: (options) => base.screenshot(options),
    addInitScript: (script) => base.addInitScript(script),
    context: () => ({
      newCDPSession: async () => {
        const index = sessions.length;
        const hits = sessionHits ? sessionHits(index, host) : [host, host, host, host, host];
        const plan = typeof sessionPlan === "function" ? (sessionPlan(index) ?? {}) : {};
        const session = createNativeOcclusionSession({ dom, host, nativeHits: hits, ...plan });
        sessions.push(session);
        return session;
      },
    }),
  };
  return {
    dom,
    host,
    body,
    rect,
    sessions,
    page,
    run: () =>
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId: TOAST_ROUTE.stateId,
        roleCatalog: [m32Role(TOAST_ROUTE.roleId)],
        policy: M31_POLICY,
      }),
  };
}

function assertToastFixedCleanup(fixture) {
  for (const tag of ["bring-into-view", "scroll-by", "scroll-to"]) {
    assert.equal(fixture.page.evaluations.includes(tag), false, `toast 固定视口不得 ${tag}`);
  }
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "restore").length, 1, "恢复一次");
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "scroll-restore").length, 1, "滚动恢复一次");
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "release-attempt").length, 1, "尝试释放一次");
  assert.equal(fixture.host.style.getPropertyValue("-webkit-text-fill-color"), "", "隐藏样式已恢复");
  assert.equal(fixture.host.style.getPropertyValue("text-shadow"), "", "阴影样式已恢复");
  for (const session of fixture.sessions) {
    const methods = session.calls.map((call) => call.method);
    assert.ok(methods.includes("Runtime.releaseObjectGroup"), "每次原生探针都释放对象组");
    assert.ok(methods.includes("detach"), "每次原生探针都分离 CDP 会话");
  }
}

test("D21-C8-D3b：toast 固定视口接真实原生命中链路，普通probe命中BODY仍可测量", async () => {
  const fixture = createToastRoutingFixture();
  const result = await fixture.run();
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.roleId, TOAST_ROUTE.roleId);
  assert.equal(record.stateId, TOAST_ROUTE.stateId);
  assert.equal(record.method, "browser-text-pixels");
  assert.equal(record.result, "pass");
  assert.ok(closeTo(record.ratio, 21, 1e-9), `黑白样本必须来自原对比度函数，实际 ${record.ratio}`);
  assert.deepEqual(
    result.diagnostics.toastStateGuards.map((entry) => entry.phase),
    TOAST_GUARD_PHASES,
  );
  assert.ok(result.diagnostics.toastStateGuards.every((entry) => entry.valid));
  assert.equal(result.diagnostics.hoverStateGuards, undefined, "hover 守卫不得混入 toast");
  const evidence = JSON.parse(record.evidence);
  const band = evidence.nodes[0].bands[0];
  // 普通 pointerProbe 命中 BODY 且保留在诊断；原生结果才是权威遮挡判定。
  assert.ok(
    band.pointerProbe.rects[0].points.every((point) => point.withinHost === false),
    "普通 probe 命中 BODY",
  );
  assert.ok(
    band.occlusion.rects[0].points.every((point) => point.withinHost === true),
    "原生命中命中原宿主",
  );
  assert.equal(band.occlusion.source, "native-cdp");
  assert.equal(band.nativeChecks.prePng.ok, true);
  assert.equal(band.nativeChecks.postPng.ok, true);
  const evaluations = fixture.page.evaluations;
  assert.ok(
    evaluations.indexOf("occlusion-probe") < evaluations.indexOf("native-occlusion-guard"),
    "先普通 probe、后原生探针",
  );
  assert.equal(evaluations.filter((tag) => tag === "hide").length, 1, "一次自然展示只 hide 一次（不重试）");
  assert.equal(fixture.sessions.length, 2, "无覆盖正例总共 2 轮 native（PNG 前 + PNG 后各一次）");
  assert.ok(
    fixture.sessions.every(
      (session) => session.calls.filter((call) => call.method === "DOM.getNodeForLocation").length === 5,
    ),
    "两轮都是完整五点原生检查",
  );
  assertToastFixedCleanup(fixture);
});

test("D21-C8-D3b：三类覆盖都不产生有效比值，PNG 后新覆盖撤销已产 PNG", async (t) => {
  await t.test("auto/opaque 起始覆盖", async () => {
    let overlay = null;
    const fixture = createToastRoutingFixture({
      sessionHits: () => [overlay, overlay, overlay, overlay, overlay],
    });
    overlay = fixture.dom.build({
      selector: ".overlay",
      id: "overlay",
      className: "overlay",
      rect: { ...fixture.rect },
    });
    overlay.isConnected = true;
    fixture.dom.setHitTest(() => overlay);
    const result = await fixture.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.match(result.records[0].reason, /宿主及其后代之外的命中/);
    assert.equal(result.captures.length, 0, "被遮挡 band 不产生 PNG");
  });
  await t.test("none/opaque 起始覆盖（普通命中放行也必须被原生拒绝）", async () => {
    let overlay = null;
    const fixture = createToastRoutingFixture({
      sessionHits: () => [overlay, overlay, overlay, overlay, overlay],
    });
    overlay = fixture.dom.build({
      selector: ".overlay",
      id: "overlay",
      className: "overlay",
      rect: { ...fixture.rect },
    });
    overlay.isConnected = true;
    overlay.pointerEvents = "none";
    fixture.dom.setHitTest(() => fixture.host);
    const result = await fixture.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.match(result.records[0].reason, /宿主及其后代之外的命中/);
    assert.equal(result.captures.length, 0);
  });
  await t.test("none/translucent PNG 后才出现覆盖", async () => {
    let overlay = null;
    const fixture = createToastRoutingFixture({
      sessionHits: (index, host) =>
        index >= 1 ? [overlay, overlay, overlay, overlay, overlay] : [host, host, host, host, host],
    });
    overlay = fixture.dom.build({
      selector: ".overlay",
      id: "overlay",
      className: "overlay",
      rect: { ...fixture.rect },
    });
    overlay.isConnected = true;
    const result = await fixture.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.match(result.records[0].reason, /PNG 后原生检查/);
    assert.equal(result.captures.length, 1, "已产 PNG 保留");
    assert.equal(result.captures[0].sampleStatus, "invalidated-toast-post-png-native");
    assert.match(result.captures[0].sampleInvalidationReason, /宿主及其后代之外的命中/);
    assert.equal(fixture.page.evaluations.includes("scan"), false, "撤销样本后不再扫描取值");
  });
});

test("D21-C8-D3b-R1：原生检查异常经完整接线保持原对象（session 方法级注入）", async (t) => {
  // pre = 第 0 个 CDP 会话（collect 内唯一一次 PNG 前原生检查）；
  // post = 第 1 个 CDP 会话（PNG 后检查）；正例已断言总共 2 轮。
  const faultAt = (index, plan) => (sessionIndex) => (sessionIndex === index ? plan : null);
  const preFault = (plan) => createToastRoutingFixture({ sessionPlan: faultAt(0, plan) });
  const postFault = (plan) => createToastRoutingFixture({ sessionPlan: faultAt(1, plan) });
  const throwValue = (value) => () => {
    throw value;
  };

  await t.test("pre 原始 0：原值原样拒绝，不转字符串", async () => {
    const fixture = preFault({ overrides: { "DOM.getNodeForLocation": throwValue(0) } });
    await assert.rejects(fixture.run(), (error) => error === 0);
    assert.equal(fixture.sessions.length, 1, "pre 抛错后不再产生 PNG 后会话");
    assertToastFixedCleanup(fixture);
  });

  await t.test("pre 冻结 Error：同一引用拒绝，冻结对象不加诊断", async () => {
    const frozen = Object.freeze(new Error("frozen toast pre"));
    const fixture = preFault({ overrides: { "DOM.getNodeForLocation": throwValue(frozen) } });
    await assert.rejects(fixture.run(), (error) => error === frozen);
    assert.equal(Object.hasOwn(frozen, "toastOcclusionEvidence"), false);
    assertToastFixedCleanup(fixture);
  });

  await t.test("pre 操作错 + release/detach 错：既有 AggregateError 顺序与 cause 保持", async () => {
    const primary = new Error("injected pre host error");
    const releaseError = new Error("injected pre release error");
    const detachError = new Error("injected pre detach error");
    const fixture = preFault({
      overrides: { "DOM.getNodeForLocation": throwValue(primary) },
      releaseError,
      detachError,
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], releaseError);
      assert.equal(error.errors[2], detachError);
      assert.equal(error.cause, primary);
      assert.equal(error.measurementEvidence.complete, false);
      assert.equal(error.measurementEvidence.captures.length, 0, "pre 异常不产生 PNG");
      return true;
    });
    assertToastFixedCleanup(fixture);
  });

  await t.test("post 原始 0：原值原样拒绝，post 异常不扫描", async () => {
    const fixture = postFault({ overrides: { "DOM.getNodeForLocation": throwValue(0) } });
    await assert.rejects(fixture.run(), (error) => error === 0);
    assert.equal(fixture.sessions.length, 2, "pre 正常、post 注入共 2 轮");
    assert.equal(fixture.page.evaluations.includes("scan"), false, "post 抛错后不扫描取值");
    assertToastFixedCleanup(fixture);
  });

  await t.test("post 冻结 Error：同一引用拒绝，PNG 标记不替换主错", async () => {
    const frozen = Object.freeze(new Error("frozen toast post"));
    const fixture = postFault({ overrides: { "DOM.getNodeForLocation": throwValue(frozen) } });
    await assert.rejects(fixture.run(), (error) => error === frozen);
    assert.equal(fixture.page.evaluations.includes("scan"), false);
    assertToastFixedCleanup(fixture);
  });

  await t.test("post 操作错 + release/detach 错：聚合保真，PNG 留失效证据", async () => {
    const primary = new Error("injected post host error");
    const releaseError = new Error("injected post release error");
    const detachError = new Error("injected post detach error");
    const fixture = postFault({
      overrides: { "DOM.getNodeForLocation": throwValue(primary) },
      releaseError,
      detachError,
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], releaseError);
      assert.equal(error.errors[2], detachError);
      assert.equal(error.cause, primary);
      const { captures } = error.measurementEvidence;
      assert.equal(captures.length, 1, "已产 PNG 作为失效部分证据保留");
      assert.equal(captures[0].sampleStatus, "invalidated-toast-post-png-native");
      assert.equal(captures[0].sampleInvalidationReason, "PNG 后原生检查异常");
      return true;
    });
    assert.equal(fixture.page.evaluations.includes("scan"), false);
    assertToastFixedCleanup(fixture);
  });

  await t.test("操作错 + 样式/滚动恢复错：原主错按序嵌套，不被恢复错替换", async () => {
    const primary = new Error("injected combined host error");
    const styleError = new Error("injected combined style restore error");
    const scrollError = new Error("injected combined scroll restore error");
    const fixture = createToastRoutingFixture({
      sessionPlan: faultAt(0, { overrides: { "DOM.getNodeForLocation": throwValue(primary) } }),
      styleRestore: throwValue(styleError),
      scrollRestore: throwValue(scrollError),
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      const sampleAggregate = error.errors[0];
      assert.ok(sampleAggregate instanceof AggregateError);
      assert.equal(sampleAggregate.errors[0], primary, "原主错仍是嵌套聚合第一项");
      assert.equal(sampleAggregate.errors[1], styleError);
      assert.equal(sampleAggregate.cause, primary);
      assert.equal(error.errors[1], scrollError);
      assert.equal(error.cause, sampleAggregate);
      assert.equal(error.measurementEvidence.complete, false);
      return true;
    });
    // 样式/滚动恢复、attempt 释放都实际执行过；CDP 会话清理不受注入影响。
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "restore").length, 1, "样式恢复已尝试一次");
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "scroll-restore").length, 1, "滚动恢复已尝试一次");
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "release-attempt").length, 1, "attempt 释放已执行");
    for (const session of fixture.sessions) {
      const methods = session.calls.map((call) => call.method);
      assert.ok(methods.includes("Runtime.releaseObjectGroup"), "原生会话释放对象组");
      assert.ok(methods.includes("detach"), "原生会话分离");
    }
  });
});

test("D21-C8-D3b：业务失态按阶段拒绝、不重试不滚动且清理仍执行", async (t) => {
  const cases = [
    [
      "after-scan 清空文字",
      5,
      (f) => {
        f.host.textContent = "";
      },
      (f) => {
        f.host.textContent = NATIVE_OCCLUSION_TEXT;
      },
      /after-scan/,
    ],
    [
      "after-scan 隐藏宿主",
      5,
      (f) => {
        f.host.hidden = true;
      },
      (f) => {
        f.host.hidden = false;
      },
      /after-scan/,
    ],
    [
      "after-scan 同 id 替换",
      5,
      (f) => {
        f.replacement = f.dom.build({
          selector: NATIVE_OCCLUSION_SELECTOR,
          id: "quota-preset-status",
          tag: "DIV",
          rect: { ...f.rect },
        });
        f.dom.replace(f.host, f.replacement);
      },
      (f) => {
        f.dom.replace(f.replacement, f.host);
      },
      /after-scan/,
    ],
    [
      "after-scan 几何漂移",
      5,
      (f) => {
        f.rect.y += 1;
      },
      (f) => {
        f.rect.y -= 1;
      },
      /after-scan/,
    ],
    [
      "after-scan 色源漂移",
      5,
      (f) => {
        f.host.style.setProperty("color", "rgb(1, 2, 3)");
      },
      (f) => {
        f.host.style.setProperty("color", "rgb(255, 255, 255)");
      },
      /after-scan/,
    ],
    [
      "after-scan 窗口滚动漂移",
      5,
      (f) => {
        f.dom.sandbox.window.scrollY = 7;
      },
      (f) => {
        f.dom.sandbox.window.scrollY = 0;
      },
      /after-scan/,
    ],
    [
      "after-verify 几何漂移",
      7,
      (f) => {
        f.rect.x += 1;
      },
      (f) => {
        f.rect.x -= 1;
      },
      /after-verify/,
    ],
    [
      "after-verify 色源漂移",
      7,
      (f) => {
        f.host.style.setProperty("background-color", "rgb(9, 9, 9)");
      },
      (f) => {
        f.host.style.removeProperty("background-color");
      },
      /after-verify/,
    ],
  ];
  for (const [label, mutateAt, mutate, revert, pattern] of cases) {
    await t.test(label, async () => {
      const fixture = createToastRoutingFixture({
        onToastGuard: (call) => {
          if (call === mutateAt) mutate(fixture);
          if (call === mutateAt + 1) revert(fixture);
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        // 同 id 替换会让原宿主脱离：样式恢复核验同时失败，按 C7 口径聚合为
        // errors[0]=主错（含阶段）、errors[1]=恢复错；其余失态回合仍是单一原错。
        const primary = error instanceof AggregateError ? error.errors[0] : error;
        assert.match(primary.message, /toast 固定视口/);
        assert.match(primary.message, pattern);
        if (error instanceof AggregateError) {
          assert.equal(error.cause, primary);
          assert.ok(
            error.errors.some((item) => /样式恢复未完成/.test(item.message)),
            "恢复错必须保留在聚合里",
          );
        }
        assert.equal(error.measurementEvidence.complete, false);
        assert.deepEqual(error.measurementEvidence.records, []);
        return true;
      });
      assertToastFixedCleanup(fixture);
      assert.equal(
        fixture.page.evaluations.filter((tag) => tag === "hide").length,
        1,
        "失态不得重试或重新展示（hide 只一次）",
      );
    });
  }
  await t.test("原异常与清理错聚合保留", async () => {
    const fixture = createToastRoutingFixture({
      scrollRestore: () => {
        throw new Error("injected toast scroll restore failure");
      },
      onToastGuard: (call) => {
        if (call === 5) fixture.host.hidden = true;
        if (call === 6) fixture.host.hidden = false;
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.errors[0].message, /toast 固定视口 after-scan/);
      assert.ok(error.errors.some((item) => /injected toast scroll restore failure/.test(item.message)));
      return true;
    });
    assertToastFixedCleanup(fixture);
  });
});

test("D21-C8-D3b：仅精确 toast 组合走新分支，缺失/已消失不得合并为 PASS", async (t) => {
  const toastProbeNode = probeNode(0, {
    tag: "span",
    id: "quotaPresetStatus",
    className: "quota-preset-status",
    rect: { ...NATIVE_OCCLUSION_RECT },
    textRects: [{ ...NATIVE_OCCLUSION_RECT }],
    rawTextRects: [{ ...NATIVE_OCCLUSION_RECT }],
    textRectClipping: {
      source: "Range.getClientRects intersected with axis overflow client rects",
      clips: [],
      discardedRawRectIndexes: [],
      roundedRejectedRawRectIndexes: [],
      unsupportedReason: null,
    },
    computed: { ...probeNode(0).computed, color: "rgb(255, 255, 255)" },
  });
  const scripted = (nodes) =>
    createScriptedPage(
      defaultHandlers({
        "node-probe": () => ({ nodes, attemptToken: "attempt-toast-route" }),
      }),
    );
  const runScripted = (page, stateId, role) =>
    measureBrowserRoles({
      page,
      candidate: null,
      mode: "light",
      stateId,
      roleCatalog: [role],
      policy: M31_POLICY,
    });

  await t.test("toast 角色在非 quota-toast 状态仍走原路径", async () => {
    const page = scripted([toastProbeNode]);
    const result = await runScripted(
      page,
      "dashboard-default",
      m32Role("toast.quota-status", { states: ["dashboard-default"] }),
    );
    assert.equal(page.evaluations.includes("toast-guard"), false);
    assert.equal(page.evaluations.includes("native-occlusion-guard"), false);
    assert.equal(result.records.length, 1);
    assert.equal(result.diagnostics.toastStateGuards, undefined);
  });
  await t.test("同选择器的其它角色即使状态相同也不启用", async () => {
    const page = scripted([toastProbeNode]);
    const result = await runScripted(
      page,
      "quota-toast",
      m32Role("page.body-text", { selector: ".quota-preset-status", states: ["quota-toast"] }),
    );
    assert.equal(page.evaluations.includes("toast-guard"), false);
    assert.equal(result.records.length, 1);
  });
  await t.test("toast 角色 selector 不同不启用", async () => {
    const page = scripted([toastProbeNode]);
    const result = await runScripted(page, "quota-toast", m32Role("toast.quota-status", { selector: ".other-status" }));
    assert.equal(page.evaluations.includes("toast-guard"), false);
    assert.equal(result.records.length, 1);
  });
  await t.test("首次缺失记 unmeasured，不并入 PASS", async () => {
    const page = scripted([]);
    const result = await runScripted(page, "quota-toast", m32Role("toast.quota-status"));
    assert.equal(result.records[0].result, "unmeasured");
    assert.match(result.records[0].reason, /未找到选择器匹配/);
    assert.equal(page.evaluations.includes("toast-guard"), false, "零目标不建守卫");
  });
  await t.test("已消失（display:none）记 unmeasured", async () => {
    const fixture = createToastRoutingFixture({ hostComputed: { display: "none" } });
    const result = await fixture.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.match(result.records[0].reason, /未渲染|没有可测节点/);
  });
});

test("D21-C7-B2：文字不可完整在当前视口采样时不滚动寻找", async () => {
  const fixture = createHoverFixedFixture({
    node: probeNode(0, {
      textRects: [{ x: 100, y: 790, width: 200, height: 20 }],
    }),
  });
  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.message, /完整落入当前视口/);
    assert.deepEqual(error.measurementEvidence.records, []);
    assert.equal(error.measurementEvidence.captures.length, 0);
    return true;
  });
  assert.equal(fixture.page.evaluations.includes("hide"), false);
  for (const tag of ["bring-into-view", "scroll-by", "scroll-to"])
    assert.equal(fixture.page.evaluations.includes(tag), false);
  assert.ok(fixture.page.evaluations.includes("release-attempt"));
});

test("D21-C7-B2：采样原错与样式、滚动恢复原错共同保留", async () => {
  const primary = new Error("original hover scan failure");
  const styleError = new Error("original hover style restore failure");
  const scrollError = new Error("original hover scroll restore failure");
  const fixture = createHoverFixedFixture({
    scan: () => {
      throw primary;
    },
    restore: () => {
      throw styleError;
    },
    scrollRestore: () => {
      throw scrollError;
    },
  });
  await assert.rejects(fixture.run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.errors[0].errors[0], primary);
    assert.strictEqual(error.errors[0].errors[1], styleError);
    assert.strictEqual(error.errors[1], scrollError);
    assert.deepEqual(error.measurementEvidence.records, []);
    assert.equal(error.measurementEvidence.captures.length, 1);
    return true;
  });
  assertHoverFixedCleanup(fixture);
});

test("D21-C7-B2：非hover文字仍执行原定位、分带和回首带", async () => {
  let probes = 0;
  const node = probeNode(0, { rect: { x: 100, y: 50, width: 200, height: 1000 } });
  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": () => ({ nodes: [++probes > 2 ? probeNode(0) : node] }),
    }),
  );
  await measureTextFixture(page);
  for (const tag of ["bring-into-view", "scroll-by", "scroll-to"]) assert.ok(page.evaluations.includes(tag), tag);
  assert.equal(page.evaluations.includes("hover-guard"), false);
});

test("D21-C7-B2：实际页内守卫复用attempt身份并在scroll stash删除后核对原容器", async () => {
  const dom = createElementStubDom();
  const rect = { x: 100, y: 50, width: 200, height: 20 };
  const spec = { selector: "#addImportButton:hover", id: "addImportButton", tag: "BUTTON", rect };
  const target = dom.build(spec);
  let hovered = true;
  target.matches = (selector) => selector === ":hover" && hovered;
  const container = dom.build({ selector: ".scroller", rect });
  container.isConnected = true;
  container.scrollTop = 7;
  container.scrollLeft = 3;
  const probe = runInNewContext(buildProbeSource("node-probe", spec.selector, null, null, true), dom.sandbox);
  assert.equal(probe.attemptToken, "a1");
  dom.sandbox.window.__skinPaletteScrollStash = { containers: [{ node: container }] };
  let source;
  const fixture = createHoverFixedFixture({
    guard: (_call, _state, actualSource) => {
      source = actualSource;
      return hostValue(runInNewContext(actualSource, dom.sandbox));
    },
  });
  const result = await fixture.run();
  const baseline = result.diagnostics.hoverStateGuards[0].observed;
  assert.equal(baseline.containers[0].top, 7);
  assert.equal(baseline.containers[0].left, 3);
  delete dom.sandbox.window.__skinPaletteScrollStash;
  container.scrollTop = 8;
  const drift = hostValue(runInNewContext(source, dom.sandbox));
  assert.equal(drift.containers[0].top, 8);
  assert.equal(drift.containers[0].identityId, baseline.containers[0].identityId);
  hovered = false;
  assert.equal(runInNewContext(source, dom.sandbox).hovered, false);
  const replacement = dom.build(spec);
  dom.replace(target, replacement);
  assert.equal(runInNewContext(source, dom.sandbox).identityValid, false);
});

test("D21-C7-B2：恢复阶段失态或结构化恢复失败均不得返回有效比值", async (t) => {
  for (const phase of [
    "after-hide",
    "before-png",
    "after-style-restore",
    "after-scroll-restore",
    "style-result",
    "scroll-result",
  ]) {
    await t.test(phase, async () => {
      const callAt = { "after-hide": 2, "before-png": 3, "after-style-restore": 6, "after-scroll-restore": 8 }[phase];
      const fixture = createHoverFixedFixture({
        guard: (call, state) => ({ ...state, hovered: call !== callAt }),
        ...(phase === "style-result" ? { restore: () => ({ ok: true, inlineRestored: false }) } : {}),
        ...(phase === "scroll-result"
          ? { scrollRestore: () => ({ ok: true, restored: false, mismatches: ["container drift"] }) }
          : {}),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.equal(error.measurementEvidence.complete, false);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 1, "不做身份重试");
        return true;
      });
      assertHoverFixedCleanup(fixture);
    });
  }
});

test("M5.2.P-A3：单metric聚光文字只在固定视口采样并全程保态", async (t) => {
  const assertSpotlightMetricPrehideCleanup = (fixture) => {
    assert.equal(fixture.hidden, false);
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 0);
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "restore").length, 0);
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "scroll-restore").length, 1);
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "release-attempt").length, 1);
    for (const tag of ["bring-into-view", "scroll-by", "scroll-to"]) {
      assert.equal(fixture.page.evaluations.includes(tag), false, tag);
    }
  };

  await t.test("精确状态/角色使用普通标签并保留检查点", async () => {
    const fixture = createSpotlightMetricFixture({
      guard: (call, state) =>
        call >= 2 && call <= 5
          ? { ...state, targetTextFillColor: "rgba(0, 0, 0, 0)", targetTextShadow: "none" }
          : state,
    });
    const result = await fixture.run();
    const measuredRecord = result.records[0];
    const measuredDiagnostics = result.diagnostics;
    assert.equal(measuredRecord.roleId, "panel.metric-label");
    assert.equal(measuredRecord.stateId, "spotlight-metric-label");
    assert.equal(measuredRecord.method, "browser-text-pixels");
    assert.equal(measuredRecord.result, "pass");
    assert.equal(JSON.parse(measuredRecord.evidence).selector, ".metric:has(> #totalTokens) > span:not(.metric-new)");
    assert.deepEqual(
      measuredDiagnostics.spotlightMetricStateGuards.map((entry) => entry.phase),
      [
        "baseline",
        "after-hide",
        "before-png",
        "after-png",
        "after-scan",
        "after-style-restore",
        "after-verify",
        "after-scroll-restore",
      ],
    );
    assert.ok(measuredDiagnostics.spotlightMetricStateGuards.every((entry) => entry.valid));
    assertHoverFixedCleanup(fixture);
  });

  await t.test("精确数值目标沿用同一固定视口守卫并核对未裁文字", async () => {
    const fixture = createSpotlightMetricValueFixture({
      guard: (call, state) =>
        call >= 2 && call <= 5
          ? { ...state, targetTextFillColor: "rgba(0, 0, 0, 0)", targetTextShadow: "none" }
          : state,
    });
    const result = await fixture.run();
    const record = result.records[0];
    assert.equal(record.roleId, "panel.metric-value");
    assert.equal(record.stateId, "spotlight-metric-label");
    assert.equal(record.method, "browser-text-pixels");
    assert.equal(record.result, "pass");
    const evidence = JSON.parse(record.evidence);
    assert.equal(evidence.selector, SPOTLIGHT_METRIC_VALUE_SELECTOR);
    assert.deepEqual(evidence.nodes[0].geometry.rawTextRects, evidence.nodes[0].geometry.textRects);
    assert.deepEqual(
      result.diagnostics.spotlightMetricStateGuards.map((entry) => entry.phase),
      [
        "baseline",
        "after-hide",
        "before-png",
        "after-png",
        "after-scan",
        "after-style-restore",
        "after-verify",
        "after-scroll-restore",
      ],
    );
    assert.ok(result.diagnostics.spotlightMetricStateGuards.every((entry) => entry.valid));
    assertHoverFixedCleanup(fixture);
  });

  for (const [name, patch, message] of [
    ["clientWidth 非有限", { targetClientWidth: Number.NaN }, /非有限/],
    ["scrollWidth 非有限", { targetScrollWidth: Number.POSITIVE_INFINITY }, /非有限/],
    ["scrollWidth 超出 clientWidth", { targetScrollWidth: 181 }, /溢出/],
  ]) {
    await t.test(`数值${name}在截图前拒绝`, async () => {
      const fixture = createSpotlightMetricValueFixture({
        guard: (call, state) => (call === 1 ? { ...state, ...patch } : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, message);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 0);
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((shot) => shot.clip).length, 0);
      assertSpotlightMetricPrehideCleanup(fixture);
    });
  }

  await t.test("即使整数宽度相等，原始 Range 矩形被小数像素裁切也拒绝", async () => {
    const fullRect = { x: 110, y: 56, width: 96, height: 24 };
    const fixture = createSpotlightMetricValueFixture({
      node: spotlightMetricValueNode({
        textRects: [{ ...fullRect, width: 95.75 }],
        rawTextRects: [fullRect],
      }),
    });
    await assert.rejects(fixture.run(), (error) => {
      const primary = error instanceof AggregateError ? error.errors[0] : error;
      assert.match(primary.message, /原始文字矩形.*裁切/);
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
    assert.equal(fixture.page.screenshots.filter((shot) => shot.clip).length, 0);
    assertSpotlightMetricPrehideCleanup(fixture);
  });

  for (const [name, patch] of [
    ["错宿主", { hostSame: false }],
    ["错leaf", { leafIsMetricValue: false }],
    ["身份替换", { targetIdentityId: 99 }],
  ]) {
    await t.test(`数值${name}仍被原聚光守卫拒绝`, async () => {
      const fixture = createSpotlightMetricValueFixture({
        guard: (call, state) => (call === 1 ? { ...state, ...patch } : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /聚光metric固定视口 baseline/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 0);
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((shot) => shot.clip).length, 0);
      assertSpotlightMetricPrehideCleanup(fixture);
    });
  }

  await t.test("近似selector不进入数值专用聚光守卫", async () => {
    const fixture = createSpotlightMetricValueFixture({
      roleOverrides: {
        selector: ".metric strong",
        selectorsByState: { "spotlight-metric-label": ".metric strong" },
      },
    });
    const result = await fixture.run();
    assert.equal(JSON.parse(result.records[0].evidence).selector, ".metric strong");
    assert.equal(result.diagnostics.spotlightMetricStateGuards, undefined);
  });

  await t.test("同角色的其它状态保留原选择器和普通测量路径", async () => {
    const fixture = createHoverFixedFixture({
      stateId: "dashboard-default",
      roleId: "panel.metric-label",
      guardTag: "spotlight-metric-guard",
    });
    const result = await fixture.run();
    assert.equal(JSON.parse(result.records[0].evidence).selector, ".metric span");
    assert.equal(result.diagnostics.spotlightMetricStateGuards, undefined);
  });

  await t.test("文字未完整落在当前视口时拒绝，且不滚动或截图", async () => {
    const fixture = createSpotlightMetricFixture({
      node: probeNode(0, { textRects: [{ x: 100, y: 790, width: 200, height: 20 }] }),
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /未完整落入当前视口/);
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
    assert.equal(fixture.page.evaluations.includes("hide"), false);
    assert.equal(fixture.page.screenshots.filter((screenshot) => screenshot.clip).length, 0);
    for (const tag of ["bring-into-view", "scroll-by", "scroll-to"])
      assert.equal(fixture.page.evaluations.includes(tag), false, tag);
    assert.ok(fixture.page.evaluations.includes("release-attempt"));
  });

  await t.test("hide时短暂失去聚光，即使随后恢复也拒绝", async () => {
    const fixture = createSpotlightMetricFixture({
      guard: (call, state) => (call === 2 ? { ...state, activeHostCount: 0, activeHostSame: false } : state),
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /after-hide/);
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
    assert.equal(fixture.page.screenshots.filter((screenshot) => screenshot.clip).length, 0);
    assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 1);
  });

  for (const drift of ["text", "foreground"]) {
    await t.test(`node-probe后baseline前${drift}变化被拒绝`, async () => {
      const fixture = createSpotlightMetricFixture({
        guard: (call, state) => {
          if (call !== 1) return state;
          return drift === "text"
            ? { ...state, targetText: "changed label" }
            : { ...state, targetColor: "rgb(1, 2, 3)" };
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /baseline/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 0);
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((screenshot) => screenshot.clip).length, 0);
      assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 0);
      assertSpotlightMetricPrehideCleanup(fixture);
    });
  }

  for (const drift of ["host", "spotlight", "container"]) {
    await t.test(`PNG后${drift}漂移会使部分截图失效`, async () => {
      const fixture = createSpotlightMetricFixture({
        guard: (call, state) => {
          if (call !== 4) return state;
          if (drift === "host") return { ...state, hostSame: false, currentHostIdentityId: 99 };
          if (drift === "spotlight") {
            return { ...state, spotlight: { ...state.spotlight, x: "121px" } };
          }
          return { ...state, containers: [{ ...state.containers[0], top: 1 }] };
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-png/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 1);
        assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-metric-state");
        assert.match(error.measurementEvidence.captures[0].sampleInvalidationReason, /after-png/);
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((screenshot) => screenshot.clip).length, 1);
      assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 1, "不重试身份");
      assertHoverFixedCleanup(fixture);
    });
  }

  for (const drift of ["text", "foreground"]) {
    await t.test(`PNG后${drift}变化即使几何不变也使截图失效`, async () => {
      const fixture = createSpotlightMetricFixture({
        guard: (call, state) => {
          if (call !== 4) return state;
          return drift === "text"
            ? { ...state, targetText: "changed label" }
            : { ...state, targetColor: "rgb(1, 2, 3)" };
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-png/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 1);
        assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-metric-state");
        assert.match(error.measurementEvidence.captures[0].sampleInvalidationReason, /after-png/);
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((screenshot) => screenshot.clip).length, 1);
      assertHoverFixedCleanup(fixture);
    });
  }

  await t.test("采样异常与样式恢复异常都保留原错误和部分截图", async () => {
    const sampleError = new Error("original spotlight scan failure");
    const restoreError = new Error("original spotlight restore failure");
    const fixture = createSpotlightMetricFixture({
      scan: () => {
        throw sampleError;
      },
      restore: () => {
        throw restoreError;
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], sampleError);
      assert.strictEqual(error.errors[1], restoreError);
      assert.strictEqual(error.cause, sampleError);
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures.length, 1);
      return true;
    });
    assertHoverFixedCleanup(fixture);
  });
});

const SPOTLIGHT_TIMELINE_STATE_ID = "spotlight-timeline-heading";
const SPOTLIGHT_TIMELINE_TARGETS = [
  {
    roleId: "panel.section-title",
    targetKind: "title",
    selector: ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #timelinePanelTitle",
    tag: "h2",
    id: "timelinePanelTitle",
    text: "Usage timeline",
    identityId: 51,
    rect: { x: 110, y: 56, width: 120, height: 24 },
  },
  {
    roleId: "panel.heading-label",
    targetKind: "range",
    selector: ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #rangeLabel",
    tag: "span",
    id: "rangeLabel",
    text: "Sep 1 – Sep 30",
    identityId: 52,
    rect: { x: 110, y: 84, width: 120, height: 18 },
  },
];

const spotlightTimelineNode = ({ tag, id, text, identityId, rect }) =>
  probeNode(0, {
    identityId,
    tag,
    id,
    text,
    rect,
    rawTextRects: [rect],
    textRects: [rect],
  });

const spotlightTimelineGuardState = (target) => {
  const snapshot = ({ identityId, text, rect, fontSize }) => ({
    identityId,
    connected: true,
    text,
    color: "rgb(0, 0, 0)",
    textFillColor: "",
    textShadow: "none",
    opacity: "1",
    display: "block",
    visibility: "visible",
    fontSize,
    fontWeight: "700",
    rect,
    rangeRects: [rect],
  });
  const title = SPOTLIGHT_TIMELINE_TARGETS[0];
  const range = SPOTLIGHT_TIMELINE_TARGETS[1];
  const selected = target.targetKind === "title" ? title : range;
  return {
    identityValid: true,
    reason: null,
    roleId: target.roleId,
    targetKind: target.targetKind,
    targetIdentityId: target.identityId,
    targetConnected: true,
    targetSame: true,
    chartHostCount: 1,
    headingCount: 1,
    titleContainerCount: 1,
    titleNodeCount: 1,
    rangeNodeCount: 1,
    titleLeaf: true,
    rangeLeaf: true,
    hostIdentityId: 40,
    currentHostIdentityId: 40,
    hostSame: true,
    hostConnected: true,
    headingSame: true,
    titleContainerSame: true,
    titleSame: true,
    rangeSame: true,
    hostHasSpotlightActive: true,
    activeHostCount: 1,
    activeHostSame: true,
    hovered: true,
    title: snapshot({ ...title, fontSize: "20px" }),
    range: snapshot({ ...range, fontSize: "13px" }),
    targetColor: "rgb(0, 0, 0)",
    targetTextFillColor: "",
    targetTextShadow: "none",
    targetRect: selected.rect,
    hostRect: { x: 0, y: 0, width: 2400, height: 1200 },
    viewport: { width: 1280, height: 800, dpr: 1 },
    scroll: { x: 0, y: 0 },
    containers: [{ identityId: 20, connected: true, top: 0, left: 0 }],
    spotlight: {
      x: "120px",
      y: "30px",
      radius: "156px",
      mask: "radial-gradient(circle, black, transparent)",
      pseudo: {
        content: '""',
        opacity: "1",
        maskImage: "radial-gradient(circle, black, transparent)",
        backgroundImage: "radial-gradient(circle, rgb(1, 2, 3), transparent)",
        position: "absolute",
        inset: "0px",
        zIndex: "-1",
        borderRadius: "4px",
        pointerEvents: "none",
        mixBlendMode: "normal",
        filter: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        transitionProperty: "none",
        transitionDuration: "0s",
      },
      hostStyle: {
        display: "block",
        visibility: "visible",
        isolation: "isolate",
        position: "relative",
        opacity: "1",
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "none",
        boxShadow: "none",
        borderRadius: "4px",
        transform: "none",
        mixBlendMode: "normal",
        filter: "none",
      },
    },
  };
};

function createSpotlightTimelineFixture({
  target = SPOTLIGHT_TIMELINE_TARGETS[0],
  node = spotlightTimelineNode(target),
  guard,
  restore,
  roleOverrides = {},
} = {}) {
  const fixture = createHoverFixedFixture({
    node,
    stateId: SPOTLIGHT_TIMELINE_STATE_ID,
    roleId: target.roleId,
    guardTag: "spotlight-timeline-heading-guard",
    guardState: spotlightTimelineGuardState(target),
    roleOverrides,
    guard,
    restore,
  });
  return fixture;
}

const assertSpotlightTimelinePrehideCleanup = (fixture) => {
  assert.equal(fixture.hidden, false);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "hide").length, 0);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "restore").length, 0);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "scroll-restore").length, 1);
  assert.equal(fixture.page.evaluations.filter((tag) => tag === "release-attempt").length, 1);
  for (const tag of ["bring-into-view", "scroll-by", "scroll-to"]) {
    assert.equal(fixture.page.evaluations.includes(tag), false, tag);
  }
};

test("M5.2.P-A13：时间分布标题组复用固定视口守卫", async (t) => {
  for (const target of SPOTLIGHT_TIMELINE_TARGETS) {
    await t.test(`${target.targetKind}在同一大图表宿主中完成八阶段测量`, async () => {
      const fixture = createSpotlightTimelineFixture({ target });
      const result = await fixture.run();
      assert.equal(result.records[0].roleId, target.roleId);
      assert.equal(result.records[0].stateId, SPOTLIGHT_TIMELINE_STATE_ID);
      assert.equal(result.records[0].result, "pass");
      assert.deepEqual(
        result.diagnostics.spotlightTimelineHeadingGuards.map(({ roleId, phase }) => [roleId, phase]),
        [
          [target.roleId, "baseline"],
          [target.roleId, "after-hide"],
          [target.roleId, "before-png"],
          [target.roleId, "after-png"],
          [target.roleId, "after-scan"],
          [target.roleId, "after-style-restore"],
          [target.roleId, "after-verify"],
          [target.roleId, "after-scroll-restore"],
        ],
      );
      assert.ok(result.diagnostics.spotlightTimelineHeadingGuards.every((entry) => entry.valid));
      assertHoverFixedCleanup(fixture);
      assert.equal(fixture.page.screenshots.filter((shot) => shot.clip).length, 1);
    });
  }

  for (const [name, patch, message] of [
    ["错chart宿主", { hostSame: false }, /原chart宿主/],
    ["错目标叶", { titleSame: false }, /原chart宿主/],
    ["范围为空", { range: { ...spotlightTimelineGuardState(SPOTLIGHT_TIMELINE_TARGETS[0]).range, text: " " } }, /为空/],
    ["节点身份替换", { targetIdentityId: 99 }, /原时间分布标题文字节点/],
    [
      "目标文字变化",
      { title: { ...spotlightTimelineGuardState(SPOTLIGHT_TIMELINE_TARGETS[0]).title, text: "Changed" } },
      /与node-probe不一致/,
    ],
  ]) {
    await t.test(`baseline拒绝${name}`, async () => {
      const fixture = createSpotlightTimelineFixture({
        guard: (call, state) => (call === 1 ? { ...state, ...patch } : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, message);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 0);
        return true;
      });
      assertSpotlightTimelinePrehideCleanup(fixture);
    });
  }

  for (const [name, mutate] of [
    ["文字", (state) => ({ ...state, title: { ...state.title, text: "Changed" } })],
    ["光点", (state) => ({ ...state, spotlight: { ...state.spotlight, x: "121px" } })],
    ["宿主身份", (state) => ({ ...state, hostIdentityId: 99 })],
  ]) {
    await t.test(`PNG后${name}漂移撤销截图`, async () => {
      const fixture = createSpotlightTimelineFixture({
        guard: (call, state) => (call === 4 ? mutate(state) : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-png/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 1);
        assert.equal(
          error.measurementEvidence.captures[0].sampleStatus,
          "invalidated-spotlight-timeline-heading-state",
        );
        return true;
      });
      assert.equal(fixture.page.screenshots.filter((shot) => shot.clip).length, 1);
      assertHoverFixedCleanup(fixture);
    });
  }

  await t.test("恢复失败使部分截图失效", async () => {
    const fixture = createSpotlightTimelineFixture({ restore: () => ({ ok: false, inlineRestored: false }) });
    await assert.rejects(fixture.run(), (error) => {
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures.length, 1);
      assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-timeline-heading-state");
      return true;
    });
    assertHoverFixedCleanup(fixture);
  });

  await t.test("近似selector与同角色其它状态不进入专用守卫", async () => {
    const target = SPOTLIGHT_TIMELINE_TARGETS[0];
    const approximate = createSpotlightTimelineFixture({
      target,
      roleOverrides: {
        selectorsByState: { [SPOTLIGHT_TIMELINE_STATE_ID]: ".timeline-title h2" },
      },
    });
    const approximateResult = await approximate.run();
    assert.equal(approximateResult.diagnostics.spotlightTimelineHeadingGuards, undefined);
    const otherState = createHoverFixedFixture({
      stateId: "dashboard-default",
      roleId: target.roleId,
      guardTag: "spotlight-timeline-heading-guard",
    });
    const otherStateResult = await otherState.run();
    assert.equal(otherStateResult.diagnostics.spotlightTimelineHeadingGuards, undefined);
  });
});

test("M5.2.P-A13：VM执行实际生成的时间标题守卫并允许宿主超出视口", async () => {
  const dom = createElementStubDom();
  const titleTarget = SPOTLIGHT_TIMELINE_TARGETS[0];
  const rangeTarget = SPOTLIGHT_TIMELINE_TARGETS[1];
  const titleRect = { x: 20, y: 24, width: 3, height: 3 };
  const rangeRect = { x: 28, y: 24, width: 3, height: 3 };
  const hostRect = { x: 0, y: 0, width: 2400, height: 1200 };
  const host = dom.build({
    selector: ".chart-panel",
    tag: "SECTION",
    className: "chart-panel",
    attributes: { "data-spotlight-active": "" },
    rect: hostRect,
    computed: { isolation: "isolate", position: "relative" },
    inline: {
      "--spotlight-x": "120px",
      "--spotlight-y": "30px",
      "--spotlight-radius": "156px",
      "--spotlight-mask": "radial-gradient(circle, black, transparent)",
    },
    pseudo: { content: '""', opacity: "1" },
    descendants: [
      {
        selector: ".timeline-heading",
        tag: "DIV",
        className: "timeline-heading",
        rect: hostRect,
        descendants: [
          {
            selector: ".timeline-title",
            tag: "DIV",
            className: "timeline-title",
            rect: hostRect,
            descendants: [
              {
                selector: titleTarget.selector,
                tag: "H2",
                id: titleTarget.id,
                text: titleTarget.text,
                rect: titleRect,
                textRects: [titleRect],
                computed: { color: "rgb(0, 0, 0)", fontWeight: "700" },
              },
              {
                selector: rangeTarget.selector,
                tag: "SPAN",
                id: rangeTarget.id,
                text: rangeTarget.text,
                rect: rangeRect,
                textRects: [rangeRect],
                computed: { color: "rgb(0, 0, 0)", fontSize: "13px" },
              },
            ],
          },
        ],
      },
    ],
  });
  host.matches = (selector) => selector === ":hover";
  for (const element of dom.elements) element.isConnected = true;
  const querySelectorAll = dom.sandbox.document.querySelectorAll.bind(dom.sandbox.document);
  const title = dom.elements.find((element) => element.id === titleTarget.id);
  const range = dom.elements.find((element) => element.id === rangeTarget.id);
  dom.sandbox.document.querySelectorAll = (selector) => {
    if (selector === ".chart-panel") return [host];
    if (selector === ".shell [data-spotlight-active]") return [host];
    if (selector === `#${titleTarget.id}`) return [title];
    if (selector === `#${rangeTarget.id}`) return [range];
    if (selector === titleTarget.selector) return [title];
    if (selector === rangeTarget.selector) return [range];
    return querySelectorAll(selector);
  };
  const baseGetComputedStyle = dom.sandbox.getComputedStyle;
  dom.sandbox.getComputedStyle = (element, pseudo = null) => {
    if (pseudo === "::after") {
      return {
        ...baseGetComputedStyle(element, pseudo),
        content: '""',
        opacity: "1",
        maskImage: "radial-gradient(circle, black, transparent)",
        webkitMaskImage: "radial-gradient(circle, black, transparent)",
        backgroundImage: "radial-gradient(circle, rgb(1, 2, 3), transparent)",
        position: "absolute",
        inset: "0px",
        zIndex: "-1",
        borderRadius: "4px",
        pointerEvents: "none",
        mixBlendMode: "normal",
        filter: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        transitionProperty: "none",
        transitionDuration: "0s",
      };
    }
    return baseGetComputedStyle(element, pseudo);
  };
  const globalWindowProps = ["innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY"];
  for (const prop of globalWindowProps) {
    Object.defineProperty(dom.sandbox, prop, {
      configurable: true,
      get: () => dom.sandbox.window[prop],
      set: (value) => {
        dom.sandbox.window[prop] = value;
      },
    });
  }
  dom.sandbox.performance = { now: () => 1 };
  dom.sandbox.window.performance = dom.sandbox.performance;
  dom.setHitTest(() => title);
  const harness = createActualSurfacePage(dom, { pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]) });
  const result = await measureBrowserRoles({
    page: harness.page,
    candidate: null,
    mode: "light",
    stateId: SPOTLIGHT_TIMELINE_STATE_ID,
    roleCatalog: [m32Role(titleTarget.roleId)],
    policy: M31_POLICY,
  });
  assert.equal(result.records[0].result, "pass");
  assert.ok(harness.evaluations.includes("spotlight-timeline-heading-guard"));
  assert.equal(result.diagnostics.spotlightTimelineHeadingGuards.length, 8);
  assert.ok(result.diagnostics.spotlightTimelineHeadingGuards.every((entry) => entry.valid));
  assert.deepEqual([dom.sandbox.window.scrollX, dom.sandbox.window.scrollY], [0, 0]);
  assert.equal(host.getBoundingClientRect().width > dom.sandbox.window.innerWidth, true);
});
function runB22CostNoteLinkProbe({
  selector = "#costEstimateNote a",
  pseudo = null,
  tag = "A",
  namespaceURI = "http://www.w3.org/1999/xhtml",
  containerId = "costEstimateNote",
  href = true,
  text = "private link label",
  childElement = false,
  targetLine = "underline",
  targetLineMissing = false,
  pLine = "none",
  noteLine = "none",
  bodyLine = "none",
  rootLine = "none",
  rootTag = "HTML",
  includeProof = true,
  trackIdentities = false,
  linkAttributes = {},
  linkInline = {},
  linkIsContentEditable = false,
  linkShadowRoot = null,
} = {}) {
  const dom = createElementStubDom();
  const rect = { x: 10, y: 10, width: 100, height: 20 };
  const targetComputed = targetLineMissing ? { textDecorationLine: undefined } : { textDecorationLine: targetLine };
  const link = {
    selector,
    tag,
    namespaceURI,
    rect,
    attributes: { ...linkAttributes, ...(href ? { href: "https://private.invalid/source" } : {}) },
    inline: linkInline,
    isContentEditable: linkIsContentEditable,
    shadowRoot: linkShadowRoot,
    text,
    computed: targetComputed,
    descendants: childElement ? [{ selector: "link-child", tag: "SPAN", rect, text: "nested" }] : [],
  };
  dom.build({
    selector: "html-root",
    tag: rootTag,
    rect,
    computed: { textDecorationLine: rootLine },
    descendants: [
      {
        selector: "body",
        tag: "BODY",
        rect,
        computed: { textDecorationLine: bodyLine },
        descendants: [
          {
            selector: "#costEstimateNote",
            tag: "DIV",
            id: containerId,
            rect,
            computed: { textDecorationLine: noteLine },
            descendants: [
              {
                selector: "note-paragraph",
                tag: "P",
                rect,
                computed: { textDecorationLine: pLine },
                descendants: [link],
              },
            ],
          },
        ],
      },
    ],
  });

  let decorationReads = 0;
  const getComputedStyle = dom.sandbox.getComputedStyle;
  dom.sandbox.getComputedStyle = (element, requestedPseudo = null) => {
    const style = getComputedStyle(element, requestedPseudo);
    return new Proxy(style, {
      get(target, property, receiver) {
        if (property === "textDecorationLine") decorationReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
  };
  const source = buildProbeSource(
    "node-probe",
    selector,
    pseudo,
    null,
    trackIdentities,
    false,
    false,
    false,
    includeProof,
  );
  const probe = hostValue(runInNewContext(source, dom.sandbox));
  return { probe, decorationReads, dom, link: dom.sandbox.document.querySelectorAll(selector)[0] };
}

test("B22：显式 opt-in 为自身 underline/none 生成直至根的无文本装饰证明", () => {
  for (const targetLine of ["underline", "none"]) {
    const { probe } = runB22CostNoteLinkProbe({ targetLine });
    const proof = probe.nodes[0].costNoteLinkDecorationProof;
    assert.equal(proof.valid, true);
    assert.equal(proof.reason, null);
    assert.deepEqual(proof.chain, [
      { tag: "a", textDecorationLine: targetLine },
      { tag: "p", textDecorationLine: "none" },
      { tag: "div", textDecorationLine: "none" },
      { tag: "body", textDecorationLine: "none" },
      { tag: "html", textDecorationLine: "none" },
    ]);
    assert.equal(proof.identity.hasHref, true);
    assert.equal(proof.identity.withinCostEstimateNote, true);
    assert.doesNotMatch(JSON.stringify(proof), /private link label|private.invalid/);
  }
});

test("B22：祖先、未知、组合或缺失装饰状态均拒绝", () => {
  const cases = [
    { pLine: "underline", reason: "ancestor-decoration-not-none" },
    { targetLine: "overline", reason: "unsupported-target-decoration" },
    { targetLine: "underline overline", reason: "unsupported-target-decoration" },
    { targetLine: "future-line", reason: "unsupported-target-decoration" },
    { targetLineMissing: true, reason: "missing-text-decoration-value" },
    { rootTag: "SECTION", reason: "chain-does-not-reach-root" },
  ];
  for (const scenario of cases) {
    const { probe } = runB22CostNoteLinkProbe(scenario);
    const proof = probe.nodes[0].costNoteLinkDecorationProof;
    assert.equal(proof.valid, false, scenario.reason);
    assert.equal(proof.reason, scenario.reason);
    assert.ok(Array.isArray(proof.chain));
  }
});

test("B22：非 opt-in 身份、伪元素与非直接文字叶只返回拒绝原因", () => {
  const cases = [
    { selector: "div a", reason: "selector-not-opted-in" },
    { pseudo: "::before", reason: "pseudo-not-supported" },
    { tag: "DIV", reason: "not-an-html-anchor" },
    { namespaceURI: "urn:other", reason: "not-an-html-anchor" },
    { href: false, reason: "missing-href" },
    { containerId: "other", reason: "outside-cost-estimate-note" },
    { childElement: true, reason: "not-direct-text-leaf" },
    { text: "   ", reason: "empty-direct-text" },
  ];
  for (const scenario of cases) {
    const { probe, decorationReads } = runB22CostNoteLinkProbe(scenario);
    const proof = probe.nodes[0].costNoteLinkDecorationProof;
    assert.equal(proof.valid, false, scenario.reason);
    assert.equal(proof.reason, scenario.reason);
    assert.equal(proof.chain, null);
    assert.equal(decorationReads, 0, "身份或结构拒绝不读取装饰链");
  }
});

test("B22：默认关闭不新增装饰读取、证明字段或文本/URL泄露", () => {
  const { probe, decorationReads } = runB22CostNoteLinkProbe({
    text: "private default label",
    includeProof: false,
  });
  const node = probe.nodes[0];
  assert.equal(Object.hasOwn(node, "costNoteLinkDecorationProof"), false);
  assert.equal(Object.hasOwn(node.chain[0], "textDecorationLine"), false);
  assert.equal(decorationReads, 0);
  assert.doesNotMatch(JSON.stringify(probe), /private default label|private.invalid/);
});

const B23_COST_NOTE_LINK_CONTEXT = Object.freeze({ roleId: "cost.note-link", stateId: "dashboard-default" });

function hideB23CostNoteLink(fixture, options = {}) {
  const {
    selector = "#costEstimateNote a",
    mode = "text",
    attemptToken = fixture.probe.attemptToken,
    identityContext = B23_COST_NOTE_LINK_CONTEXT,
  } = options;
  return hostValue(
    runInNewContext(buildProbeSource("hide", selector, 0, mode, attemptToken, identityContext), fixture.dom.sandbox),
  );
}

function b23SessionState(fixture) {
  return fixture.dom.sandbox.window.__skinPaletteMeasurementStash;
}

test("B23：链接隐藏仅接受精确角色、状态、text 模式和正式尝试身份", () => {
  const cases = [
    { identityContext: null },
    { identityContext: { roleId: "other", stateId: "dashboard-default" } },
    { identityContext: { roleId: "cost.note-link", stateId: "other" } },
    { mode: "surface" },
    { attemptToken: null },
  ];
  for (const options of cases) {
    const fixture = runB22CostNoteLinkProbe({ trackIdentities: true });
    const hide = hideB23CostNoteLink(fixture, options);
    assert.equal(Object.hasOwn(hide, "costNoteLinkDecorationProof"), false);
    assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), "");
    if (hide.token) {
      const release = hostValue(
        runInNewContext(buildProbeSource("release-attempt", fixture.probe.attemptToken), fixture.dom.sandbox),
      );
      assert.equal(release.ok, true);
      assert.equal(b23SessionState(fixture).sessions.size, 0);
    } else if (hide.originals) {
      runInNewContext(buildProbeSource("restore", "#costEstimateNote a", 0, hide.originals), fixture.dom.sandbox);
    }
  }
});

test("B23：只去掉自身 underline、验证 none，且证明不包含链接文字或 URL", () => {
  for (const targetLine of ["underline", "none"]) {
    const fixture = runB22CostNoteLinkProbe({ targetLine, trackIdentities: true });
    const hide = hideB23CostNoteLink(fixture);
    assert.equal(hide.ok, true);
    assert.equal(hide.costNoteLinkDecorationProof.valid, true);
    assert.equal(hide.costNoteLinkDecorationProof.chain[0].textDecorationLine, targetLine);
    assert.deepEqual(hide.costNoteLinkDecoration, {
      changed: targetLine === "underline",
      installed: true,
      computedTextDecorationLine: "none",
    });
    assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), targetLine === "underline" ? "none" : "");
    assert.equal(
      fixture.link.style.getPropertyPriority("text-decoration-line"),
      targetLine === "underline" ? "important" : "",
    );
    assert.doesNotMatch(JSON.stringify(hide), /private link label|private\.invalid/);
    const restore = hostValue(runInNewContext(buildProbeSource("restore", hide.token), fixture.dom.sandbox));
    const verify = hostValue(runInNewContext(buildProbeSource("verify", hide.token), fixture.dom.sandbox));
    assert.equal(restore.inlineRestored, true);
    assert.equal(verify.inlineRestored, true);
    assert.equal(b23SessionState(fixture).sessions.size, 0);
  }
});

test("B23：祖先、未知、组合、缺失或无效链接证明在写入前拒绝", () => {
  const cases = [
    { pLine: "underline", reason: "ancestor-decoration-not-none" },
    { targetLine: "overline", reason: "unsupported-target-decoration" },
    { targetLine: "underline overline", reason: "unsupported-target-decoration" },
    { targetLineMissing: true, reason: "missing-text-decoration-value" },
    { rootTag: "SECTION", reason: "chain-does-not-reach-root" },
    { href: false, reason: "missing-href" },
    { linkIsContentEditable: true, reason: "editable-or-unknown" },
    { childElement: true, reason: "not-direct-text-leaf" },
  ];
  for (const scenario of cases) {
    const fixture = runB22CostNoteLinkProbe({ ...scenario, trackIdentities: true });
    let writes = 0;
    for (const element of fixture.dom.elements) {
      const setProperty = element.style.setProperty;
      element.style.setProperty = (...args) => {
        writes += 1;
        return setProperty(...args);
      };
    }
    const hide = hideB23CostNoteLink(fixture);
    assert.equal(hide.ok, false, scenario.reason);
    assert.equal(hide.reason, scenario.reason);
    assert.equal(writes, 0, "拒绝证明不能先写任何内联样式");
    assert.equal(b23SessionState(fixture).sessions.size, 0);
  }
});

test("B23：恢复 underline 声明的值、priority 与原 style 属性存在性", () => {
  const cases = [
    { name: "missing", linkAttributes: {}, linkInline: {}, stylePresent: false },
    { name: "empty", linkAttributes: { style: "" }, linkInline: {}, stylePresent: true },
    {
      name: "existing-important",
      linkAttributes: {},
      linkInline: { "text-decoration-line": "underline", "text-decoration-line!priority": "important", color: "red" },
      stylePresent: true,
    },
  ];
  for (const scenario of cases) {
    const fixture = runB22CostNoteLinkProbe({
      ...scenario,
      targetLine: "underline",
      trackIdentities: true,
    });
    assert.equal(fixture.link.hasAttribute("style"), scenario.stylePresent, scenario.name);
    const hide = hideB23CostNoteLink(fixture);
    assert.equal(hide.ok, true, scenario.name);
    assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), "none", scenario.name);
    const restore = hostValue(runInNewContext(buildProbeSource("restore", hide.token), fixture.dom.sandbox));
    const verify = hostValue(runInNewContext(buildProbeSource("verify", hide.token), fixture.dom.sandbox));
    assert.equal(restore.inlineRestored, true, scenario.name);
    assert.equal(verify.inlineRestored, true, scenario.name);
    assert.equal(fixture.link.hasAttribute("style"), scenario.stylePresent, scenario.name);
    if (scenario.name === "existing-important") {
      assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), "underline");
      assert.equal(fixture.link.style.getPropertyPriority("text-decoration-line"), "important");
      assert.equal(fixture.link.style.getPropertyValue("color"), "red");
    } else {
      assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), "");
      assert.equal(fixture.link.style.getPropertyPriority("text-decoration-line"), "");
    }
  }
});

test("B23：样式写入或 decoration 安装抛错后 release 恢复并释放 session", () => {
  const throwCases = ["style-write", "decoration-install"];
  for (const throwCase of throwCases) {
    const fixture = runB22CostNoteLinkProbe({ trackIdentities: true });
    if (throwCase === "style-write") {
      const setProperty = fixture.link.style.setProperty;
      fixture.link.style.setProperty = (property, value, priority) => {
        setProperty(property, value, priority);
        if (property === "-webkit-text-fill-color") throw new Error("simulated style write fault");
      };
    } else {
      fixture.link.getBoundingClientRect = () => {
        throw new Error("simulated decoration install fault");
      };
    }
    assert.throws(() => hideB23CostNoteLink(fixture), /simulated .* fault/);
    assert.equal(b23SessionState(fixture).sessions.size, 1, throwCase);
    const release = hostValue(
      runInNewContext(buildProbeSource("release-attempt", fixture.probe.attemptToken), fixture.dom.sandbox),
    );
    assert.equal(release.ok, true, throwCase);
    assert.equal(release.releasedSessions, 1, throwCase);
    assert.equal(b23SessionState(fixture).sessions.size, 0, throwCase);
    assert.equal(fixture.link.style.getPropertyValue("-webkit-text-fill-color"), "", throwCase);
    assert.equal(fixture.link.style.getPropertyValue("text-decoration-line"), "", throwCase);
    assert.equal(fixture.link.hasAttribute("style"), false, throwCase);
  }
});

test("B23：恢复故障通过 inlineRestored 与 release 错误显式失败", () => {
  const fixture = runB22CostNoteLinkProbe({
    targetLine: "underline",
    linkInline: { "text-decoration-line": "underline", "text-decoration-line!priority": "important" },
    trackIdentities: true,
  });
  const hide = hideB23CostNoteLink(fixture);
  assert.equal(hide.ok, true);
  const setProperty = fixture.link.style.setProperty;
  fixture.link.style.setProperty = (property, value, priority) => {
    if (property === "text-decoration-line" && value === "underline") {
      throw new Error("simulated restore fault");
    }
    return setProperty(property, value, priority);
  };
  const restore = hostValue(runInNewContext(buildProbeSource("restore", hide.token), fixture.dom.sandbox));
  assert.equal(restore.inlineRestored, false);
  assert.match(restore.restoreErrors.join(" "), /simulated restore fault/);
  const verify = hostValue(runInNewContext(buildProbeSource("verify", hide.token), fixture.dom.sandbox));
  assert.equal(verify.inlineRestored, false);
  assert.equal(b23SessionState(fixture).sessions.has(hide.token), true);
  const release = hostValue(
    runInNewContext(buildProbeSource("release-attempt", fixture.probe.attemptToken), fixture.dom.sandbox),
  );
  assert.equal(release.ok, false);
  assert.match(release.failures.join(" "), /text-decoration-line/);
});

function createB24CostNoteLinkSample({
  ancestorLine = "none",
  linkInline = {},
  beforeNodeProbe = () => {},
  afterNodeProbe = () => {},
} = {}) {
  const dom = createElementStubDom();
  const rect = { x: 10, y: 10, width: 100, height: 20 };
  dom.build({
    selector: "html-root",
    tag: "HTML",
    rect,
    computed: { textDecorationLine: "none" },
    descendants: [
      {
        selector: "body",
        tag: "BODY",
        rect,
        computed: { textDecorationLine: "none" },
        descendants: [
          {
            selector: "#costEstimateNote",
            tag: "DIV",
            id: "costEstimateNote",
            rect,
            computed: { textDecorationLine: "none" },
            descendants: [
              {
                selector: "note-paragraph",
                tag: "P",
                rect,
                computed: { textDecorationLine: ancestorLine },
                descendants: [
                  {
                    selector: "#costEstimateNote a",
                    tag: "A",
                    id: "source-link",
                    rect,
                    text: "private link label",
                    attributes: { href: "https://private.invalid/source" },
                    inline: {
                      color: "rgb(220, 0, 0)",
                      "-webkit-text-fill-color": "rgb(0, 0, 0)",
                      ...linkInline,
                    },
                    computed: { textDecorationLine: "underline" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const link = dom.elements.find((element) => element._selector === "#costEstimateNote a");
  const paragraph = dom.elements.find((element) => element.tagName === "P");
  dom.setHitTest(() => link);
  const harness = createActualSurfacePage(dom, {
    pixels: d8f2PixelGrid([255, 255, 255], [255, 255, 255]),
  });
  const events = [];
  const evaluate = harness.page.evaluate.bind(harness.page);
  let nodeProbeCount = 0;
  harness.page.evaluate = async (source, argument) => {
    if (typeof source !== "string") return evaluate(source, argument);
    const tag = /^\/\/ skinProbe: ([\w-]+)/.exec(source)?.[1] ?? null;
    if (tag === "node-probe") {
      nodeProbeCount += 1;
      beforeNodeProbe({ count: nodeProbeCount, dom, link, paragraph });
    }
    const result = await evaluate(source, argument);
    if (tag === "node-probe") afterNodeProbe({ count: nodeProbeCount, dom, link, paragraph, result });
    events.push({
      tag,
      ...(tag === "node-probe" || tag === "hide" ? { source, result } : {}),
    });
    return result;
  };
  const role = ROLE_CATALOG.find((entry) => entry.id === "cost.note-link");
  const run = (selectedRole = role, stateId = "dashboard-default") =>
    measureBrowserRoles({
      page: harness.page,
      candidate: null,
      mode: "light",
      stateId,
      roleCatalog: [selectedRole],
      policy: M31_POLICY,
    });
  return { dom, link, paragraph, harness, events, role, run };
}

test("B24：真实 cost.note-link 精确路由验证探测、隐藏、前景色与恢复证据", async () => {
  const sample = createB24CostNoteLinkSample();
  const result = await sample.run();
  const record = result.records[0];
  const probes = sample.events.filter((entry) => entry.tag === "node-probe");
  const hide = sample.events.find((entry) => entry.tag === "hide");
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.roleId, "cost.note-link");
  assert.equal(record.stateId, "dashboard-default");
  assert.equal(record.result, "pass");
  assert.ok(record.ratio > 4.5);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((entry) => /includeCostNoteLinkDecorationProof = true/.test(entry.source)));
  assert.equal(probes[0].result.nodes[0].computed.color, "rgb(220, 0, 0)");
  assert.equal(probes[0].result.nodes[0].computed.textFillColor, "rgb(0, 0, 0)");
  assert.equal(evidence.nodes[0].colorValue, "rgb(0, 0, 0)");
  assert.deepEqual(evidence.nodes[0].costNoteLinkDecoration.hidden, {
    changed: true,
    installed: true,
    computedTextDecorationLine: "none",
  });
  assert.equal(evidence.nodes[0].costNoteLinkDecoration.probe.valid, true);
  assert.equal(evidence.nodes[0].costNoteLinkDecoration.hide.valid, true);
  assert.equal(evidence.nodes[0].bands[0].costNoteLinkDecorationProof.chain[0].textDecorationLine, "none");
  assert.doesNotMatch(record.evidence, /private link label|private\.invalid/);
  assert.doesNotMatch(JSON.stringify(hide.result), /private link label|private\.invalid/);
  assert.ok(["restore", "verify", "release-attempt"].every((tag) => sample.events.some((entry) => entry.tag === tag)));
  assert.equal(sample.harness.screenshots.length, 1);
  assert.equal(sample.link.style.getPropertyValue("text-decoration-line"), "");
  assert.equal(sample.link.style.getPropertyValue("-webkit-text-fill-color"), "rgb(0, 0, 0)");
  assert.equal(sample.dom.sandbox.window.__skinPaletteMeasurementStash.sessions.size, 0);
  assert.equal(sample.dom.sandbox.window.__skinPaletteMeasurementStash.attempts.size, 0);
});

test("B24：初始证明缺失或祖先带装饰时采样前拒测", async (t) => {
  await t.test("缺少 opt-in 证明", async () => {
    const sample = createB24CostNoteLinkSample({
      afterNodeProbe: ({ count, result }) => {
        if (count === 1) delete result.nodes[0].costNoteLinkDecorationProof;
      },
    });
    const result = await sample.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.equal(sample.harness.screenshots.length, 0);
    assert.ok(!sample.events.some((entry) => ["hide", "scan"].includes(entry.tag)));
    assert.ok(sample.events.some((entry) => entry.tag === "release-attempt"));
    assert.equal(JSON.parse(result.records[0].evidence).nodes[0].costNoteLinkDecorationProof, null);
  });
  await t.test("祖先有 underline", async () => {
    const sample = createB24CostNoteLinkSample({ ancestorLine: "underline" });
    const result = await sample.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.equal(sample.harness.screenshots.length, 0);
    assert.ok(!sample.events.some((entry) => ["hide", "scan"].includes(entry.tag)));
    assert.equal(JSON.parse(result.records[0].evidence).nodes[0].costNoteLinkDecorationProof.valid, false);
  });
});

test("B24：隐藏后祖先、链接身份或文字范围漂移会作废并重试", async (t) => {
  const cases = [
    {
      name: "祖先装饰变化",
      mutate: ({ paragraph }) => {
        paragraph._computed.textDecorationLine = "underline";
      },
    },
    {
      name: "链接身份变化",
      mutate: ({ link }) => {
        link.childNodes.push({ nodeType: 3, textContent: "another private node" });
      },
    },
    {
      name: "文字范围变化",
      mutate: ({ link }) => {
        link._textRects = link._textRects.map((rect) => ({ ...rect, x: rect.x + 1 }));
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const sample = createB24CostNoteLinkSample({
        beforeNodeProbe: ({ count, ...fixture }) => {
          if (count > 1 && count % 2 === 0) scenario.mutate(fixture);
        },
      });
      const result = await sample.run();
      assert.equal(result.records[0].result, "unmeasured");
      assert.equal(sample.harness.screenshots.length, 0);
      assert.ok(!sample.events.some((entry) => entry.tag === "scan"));
      assert.equal(sample.events.filter((entry) => entry.tag === "release-attempt").length, 2);
      assert.equal(sample.link.style.getPropertyValue("-webkit-text-fill-color"), "rgb(0, 0, 0)");
      assert.equal(sample.link.style.getPropertyValue("text-decoration-line"), "");
    });
  }
});

test("B24：隐藏证明未验证或写入异常时不采样并释放尝试", async (t) => {
  await t.test("computed underline 表示隐藏未安装", async () => {
    const sample = createB24CostNoteLinkSample();
    const getComputedStyle = sample.dom.sandbox.getComputedStyle;
    sample.dom.sandbox.getComputedStyle = (element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      if (element === sample.link && element.style.getPropertyValue("text-decoration-line") === "none") {
        return { ...style, textDecorationLine: "underline" };
      }
      return style;
    };
    const result = await sample.run();
    assert.equal(result.records[0].result, "unmeasured");
    assert.equal(sample.harness.screenshots.length, 0);
    assert.ok(!sample.events.some((entry) => entry.tag === "scan"));
    assert.equal(sample.events.filter((entry) => entry.tag === "release-attempt").length, 2);
    assert.equal(sample.link.style.getPropertyValue("-webkit-text-fill-color"), "rgb(0, 0, 0)");
    assert.equal(sample.link.style.getPropertyValue("text-decoration-line"), "");
  });
  await t.test("style write throws after registering its session", async () => {
    const sample = createB24CostNoteLinkSample();
    const setProperty = sample.link.style.setProperty;
    sample.link.style.setProperty = (property, value, priority) => {
      setProperty(property, value, priority);
      if (property === "-webkit-text-fill-color" && value === "transparent") {
        throw new Error("simulated B24 style write fault");
      }
    };
    await assert.rejects(sample.run(), /simulated B24 style write fault/);
    assert.equal(sample.harness.screenshots.length, 0);
    assert.ok(!sample.events.some((entry) => entry.tag === "scan"));
    assert.ok(sample.events.some((entry) => entry.tag === "release-attempt"));
    assert.equal(sample.link.style.getPropertyValue("-webkit-text-fill-color"), "rgb(0, 0, 0)");
    assert.equal(sample.link.style.getPropertyValue("text-decoration-line"), "");
    assert.equal(sample.dom.sandbox.window.__skinPaletteMeasurementStash.sessions.size, 0);
  });
});

test("B24：链接样式恢复失败保留诊断且不能返回 PASS", async () => {
  const sample = createB24CostNoteLinkSample({
    linkInline: {
      "text-decoration-line": "underline",
      "text-decoration-line!priority": "important",
    },
  });
  const setProperty = sample.link.style.setProperty;
  sample.link.style.setProperty = (property, value, priority) => {
    if (property === "text-decoration-line" && value === "underline") {
      throw new Error("simulated B24 restore fault");
    }
    return setProperty(property, value, priority);
  };
  await assert.rejects(sample.run(), (error) => {
    assert.equal(error.measurementEvidence.complete, false);
    assert.ok(error.measurementEvidence.captures.length > 0);
    assert.ok(
      error.measurementEvidence.diagnostics.restoration.inlineRestoreFailures.some((entry) =>
        /cost\.note-link.*恢复/.test(entry),
      ),
    );
    return true;
  });
  assert.equal(sample.harness.screenshots.length, 1);
  assert.ok(sample.events.some((entry) => entry.tag === "verify"));
  assert.ok(sample.events.some((entry) => entry.tag === "release-attempt"));
});

test("B24：角色或原始 selector 近似匹配时保持默认探测与隐藏", async (t) => {
  await t.test("cost.note-text 指向链接仍不启用链接证明", async () => {
    const sample = createB24CostNoteLinkSample();
    const bodyRole = ROLE_CATALOG.find((entry) => entry.id === "cost.note-text");
    const result = await sample.run({ ...bodyRole, selector: "#costEstimateNote a" });
    const probes = sample.events.filter((entry) => entry.tag === "node-probe");
    const hide = sample.events.find((entry) => entry.tag === "hide");
    assert.equal(result.records[0].roleId, "cost.note-text");
    assert.ok(probes.every((entry) => !/includeCostNoteLinkDecorationProof = true/.test(entry.source)));
    assert.equal(Object.hasOwn(probes[0].result.nodes[0], "costNoteLinkDecorationProof"), false);
    assert.equal(Object.hasOwn(hide.result, "costNoteLinkDecorationProof"), false);
    assert.doesNotMatch(result.records[0].evidence, /private link label|private\.invalid/);
  });
  await t.test("raw selector 多一个空格不启用精确路由", async () => {
    const sample = createB24CostNoteLinkSample();
    const querySelectorAll = sample.dom.sandbox.document.querySelectorAll;
    sample.dom.sandbox.document.querySelectorAll = (selector) => querySelectorAll(selector.trim());
    const result = await sample.run({ ...sample.role, selector: "#costEstimateNote a " });
    const probes = sample.events.filter((entry) => entry.tag === "node-probe");
    const hide = sample.events.find((entry) => entry.tag === "hide");
    assert.equal(result.records[0].roleId, "cost.note-link");
    assert.ok(probes.every((entry) => !/includeCostNoteLinkDecorationProof = true/.test(entry.source)));
    assert.equal(Object.hasOwn(probes[0].result.nodes[0], "costNoteLinkDecorationProof"), false);
    assert.equal(Object.hasOwn(hide.result, "costNoteLinkDecorationProof"), false);
    assert.equal(sample.link.style.getPropertyValue("text-decoration-line"), "");
  });
});

const SPOTLIGHT_DETAIL_HEADING_STATE_ID = "spotlight-detail-bars";
const SPOTLIGHT_DETAIL_HEADING_TARGETS = [
  {
    roleId: "panel.section-title",
    targetKind: "title",
    selector: "#detailPanel[data-spotlight-active] > .panel-heading > #detailPanelTitle:not(:empty)",
    tag: "h2",
    id: "detailPanelTitle",
    text: "Details",
    identityId: 71,
    rect: { x: 90, y: 54, width: 72, height: 22 },
  },
  {
    roleId: "panel.heading-label",
    targetKind: "mode-label",
    selector: "#detailPanel[data-spotlight-active] > .panel-heading > #detailModeLabel:not(:empty)",
    tag: "span",
    id: "detailModeLabel",
    text: "By channel",
    identityId: 72,
    rect: { x: 90, y: 80, width: 84, height: 16 },
  },
];
const SPOTLIGHT_DETAIL_ROW_TARGETS = [
  {
    roleId: "panel.detail-bar-name",
    targetKind: "name",
    selector:
      "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty)",
  },
  {
    roleId: "panel.detail-bar-value",
    targetKind: "value",
    selector:
      "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-value:not(:empty)",
  },
];

const spotlightDetailHeadingNode = (target) =>
  probeNode(0, {
    identityId: target.identityId,
    tag: target.tag,
    id: target.id,
    text: target.text,
    rect: target.rect,
    rawTextRects: [target.rect],
    textRects: [target.rect],
    computed: {
      color: "rgb(0, 0, 0)",
      fontSize: target.targetKind === "title" ? "20px" : "13px",
      fontWeight: target.targetKind === "title" ? "700" : "400",
      opacity: "1",
      textShadow: "none",
      textFillColor: "",
      visibility: "visible",
      display: "block",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
    },
  });

const spotlightDetailHeadingGuardState = (target) => {
  const titleTarget = SPOTLIGHT_DETAIL_HEADING_TARGETS[0];
  const modeTarget = SPOTLIGHT_DETAIL_HEADING_TARGETS[1];
  const selected = target.targetKind === "title" ? titleTarget : modeTarget;
  const snapshot = (entry) => ({
    identityId: entry.identityId,
    connected: true,
    text: entry.text,
    color: "rgb(0, 0, 0)",
    textFillColor: "",
    textShadow: "none",
    opacity: "1",
    display: "block",
    visibility: "visible",
    fontSize: entry.targetKind === "title" ? "20px" : "13px",
    fontWeight: entry.targetKind === "title" ? "700" : "400",
    rect: entry.rect,
    rangeRects: [entry.rect],
  });
  return {
    identityValid: true,
    reason: null,
    roleId: target.roleId,
    targetKind: target.targetKind,
    targetIdentityId: target.identityId,
    targetConnected: true,
    targetSame: true,
    panelCount: 1,
    shellPanelCount: 1,
    headingCount: 1,
    titleNodeCount: 1,
    modeNodeCount: 1,
    listNodeCount: 1,
    titleLeaf: true,
    modeLeaf: true,
    listIsDirectChild: true,
    hostIdentityId: 40,
    hostSame: true,
    hostConnected: true,
    headingSame: true,
    titleSame: true,
    modeLabelSame: true,
    listSame: true,
    listVisible: true,
    hostHasSpotlightActive: true,
    activeHostCount: 1,
    activeHostSame: true,
    hovered: true,
    title: snapshot(titleTarget),
    modeLabel: snapshot(modeTarget),
    targetColor: "rgb(0, 0, 0)",
    targetTextFillColor: "",
    targetTextShadow: "none",
    targetRect: selected.rect,
    hostRect: { x: 0, y: 0, width: 2400, height: 1200 },
    viewport: { width: 1280, height: 800, dpr: 1 },
    scroll: { x: 0, y: 0 },
    scrollChainSame: true,
    scrollChain: [
      { identityId: 44, connected: true, id: "detailList", top: 0, left: 0 },
      { identityId: 40, connected: true, id: "detailPanel", top: 0, left: 0 },
    ],
    scrollSessionContainers: [{ identityId: 44, connected: true, top: 0, left: 0 }],
    spotlight: {
      x: "120px",
      y: "30px",
      radius: "156px",
      mask: "radial-gradient(circle, black, transparent)",
      pseudo: {
        content: '""',
        opacity: "1",
        maskImage: "radial-gradient(circle, black, transparent)",
        backgroundImage: "radial-gradient(circle, rgb(1, 2, 3), transparent)",
        position: "absolute",
        inset: "0px",
        zIndex: "0",
        borderRadius: "4px",
        pointerEvents: "none",
        mixBlendMode: "normal",
        filter: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        transitionProperty: "none",
        transitionDuration: "0s",
      },
      hostStyle: {
        display: "block",
        visibility: "visible",
        isolation: "isolate",
        position: "relative",
        opacity: "1",
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "none",
        boxShadow: "none",
        borderRadius: "4px",
        transform: "none",
        mixBlendMode: "normal",
        filter: "none",
      },
    },
  };
};

function createSpotlightDetailHeadingFixture({
  target = SPOTLIGHT_DETAIL_HEADING_TARGETS[0],
  node = spotlightDetailHeadingNode(target),
  guard,
  restore,
  roleOverrides = {},
} = {}) {
  return createHoverFixedFixture({
    node,
    stateId: SPOTLIGHT_DETAIL_HEADING_STATE_ID,
    roleId: target.roleId,
    guardTag: "spotlight-detail-heading-guard",
    guardState: spotlightDetailHeadingGuardState(target),
    guard,
    restore,
    roleOverrides: {
      selectorsByState: { [SPOTLIGHT_DETAIL_HEADING_STATE_ID]: target.selector },
      ...roleOverrides,
    },
  });
}

test("A18：基准要求唯一活动详情宿主和两片可见的非空纯文字叶", async (t) => {
  for (const [name, patch, expected] of [
    [
      "模式说明为空",
      { modeLabel: { ...spotlightDetailHeadingGuardState(SPOTLIGHT_DETAIL_HEADING_TARGETS[0]).modeLabel, text: " " } },
      /为空/,
    ],
    ["重复详情宿主", { panelCount: 2 }, /宿主/],
    ["另有活动聚光宿主", { activeHostCount: 2 }, /唯一详情聚光宿主/],
  ]) {
    await t.test(name, async () => {
      const fixture = createSpotlightDetailHeadingFixture({
        guard: (call, state) => (call === 1 ? { ...state, ...patch } : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, expected);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 0);
        return true;
      });
      assertSpotlightTimelinePrehideCleanup(fixture);
    });
  }
});

test("A18：隐藏期间只允许当前目标的文字填充和阴影变化", async (t) => {
  await t.test("目标叶隐藏样式改变仍可通过", async () => {
    const fixture = createSpotlightDetailHeadingFixture({
      guard: (call, state) =>
        call === 2
          ? {
              ...state,
              title: { ...state.title, textFillColor: "transparent", textShadow: "none" },
              targetTextFillColor: "transparent",
              targetTextShadow: "none",
            }
          : state,
    });
    assert.equal((await fixture.run()).records[0].result, "pass");
  });
  await t.test("另一片叶样式漂移立即拒绝", async () => {
    const fixture = createSpotlightDetailHeadingFixture({
      guard: (call, state) =>
        call === 2 ? { ...state, modeLabel: { ...state.modeLabel, textShadow: "0 1px rgb(0, 0, 0)" } } : state,
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /发生漂移/);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
    assertHoverFixedCleanup(fixture);
  });
});

test("A18：仅精确状态、角色及 A17 rawSelector 进入专用守卫", async (t) => {
  await t.test("rawSelector 多一个空格时不进入", async () => {
    const target = SPOTLIGHT_DETAIL_HEADING_TARGETS[0];
    const fixture = createSpotlightDetailHeadingFixture({
      target,
      roleOverrides: { selectorsByState: { [SPOTLIGHT_DETAIL_HEADING_STATE_ID]: `${target.selector} ` } },
    });
    const result = await fixture.run();
    assert.equal(result.diagnostics.spotlightDetailHeadingGuards, undefined);
  });
  await t.test("同一角色的其它状态不进入", async () => {
    const target = SPOTLIGHT_DETAIL_HEADING_TARGETS[0];
    const fixture = createHoverFixedFixture({
      node: spotlightDetailHeadingNode(target),
      stateId: "dashboard-default",
      roleId: target.roleId,
      guardTag: "spotlight-detail-heading-guard",
      roleOverrides: { selectorsByState: { "dashboard-default": target.selector } },
    });
    const result = await fixture.run();
    assert.equal(result.diagnostics.spotlightDetailHeadingGuards, undefined);
  });
});

test("A18：PNG 后身份或文字漂移使部分截图失效", async (t) => {
  const target = SPOTLIGHT_DETAIL_HEADING_TARGETS[0];
  for (const [name, mutate] of [
    ["目标身份替换", (state) => ({ ...state, targetIdentityId: 999 })],
    ["原文字变化", (state) => ({ ...state, title: { ...state.title, text: "Changed" } })],
  ]) {
    await t.test(name, async () => {
      const fixture = createSpotlightDetailHeadingFixture({
        target,
        guard: (call, state) => (call === 4 ? mutate(state) : state),
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-png/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 1);
        assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-detail-heading-state");
        return true;
      });
      assertHoverFixedCleanup(fixture);
    });
  }
});

test("A18：恢复故障使已有详情标题截图失效", async () => {
  const fixture = createSpotlightDetailHeadingFixture({
    restore: () => ({ ok: false, inlineRestored: false, decorationRestored: false }),
  });
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(error.measurementEvidence.records, []);
    assert.equal(error.measurementEvidence.captures.length, 1);
    assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-detail-heading-state");
    return true;
  });
  assertHoverFixedCleanup(fixture);
});

function createSpotlightDetailHeadingDom({ detailRows = 0 } = {}) {
  const dom = createElementStubDom();
  const titleRect = { x: 20, y: 24, width: 3, height: 3 };
  const modeRect = { x: 28, y: 24, width: 3, height: 3 };
  const hostRect = { x: 0, y: 0, width: 2400, height: 1200 };
  const rowSpecs = Array.from({ length: detailRows }, (_, index) => {
    const y = 112 + index * 42;
    const nameRect = { x: 18, y: y + 5, width: 96, height: 14 };
    const valueRect = { x: 650, y: y + 5, width: 48, height: 14 };
    return {
      selector: `.spotlight-detail-row-${index}`,
      tag: "DIV",
      className: "bar-row",
      rect: { x: 10, y, width: 720, height: 34 },
      descendants: [
        {
          selector: `.spotlight-detail-label-${index}`,
          tag: "DIV",
          className: "bar-label",
          rect: { x: 16, y: y + 2, width: 704, height: 20 },
          descendants: [
            {
              selector: SPOTLIGHT_DETAIL_ROW_TARGETS[0].selector,
              tag: "SPAN",
              className: "bar-name",
              id: `detailBarName${index}`,
              text: `Model ${index + 1}`,
              rect: nameRect,
              textRects: [nameRect],
              computed: { color: "rgb(0, 0, 0)" },
            },
            {
              selector: SPOTLIGHT_DETAIL_ROW_TARGETS[1].selector,
              tag: "SPAN",
              className: "bar-value",
              id: `detailBarValue${index}`,
              text: `${(index + 1) * 1000} tokens`,
              rect: valueRect,
              textRects: [valueRect],
              computed: { color: "rgb(0, 0, 0)" },
            },
          ],
        },
        {
          selector: `.spotlight-detail-track-${index}`,
          tag: "DIV",
          className: "bar-track",
          rect: { x: 16, y: y + 24, width: 704, height: 10 },
        },
      ],
    };
  });
  dom.build({
    selector: ".shell",
    tag: "MAIN",
    className: "shell",
    rect: hostRect,
    descendants: [
      {
        selector: "#detailPanel",
        tag: "SECTION",
        id: "detailPanel",
        className: "detail-panel",
        attributes: { "data-spotlight-active": "" },
        rect: hostRect,
        computed: { isolation: "isolate", position: "relative" },
        inline: {
          "--spotlight-x": "120px",
          "--spotlight-y": "30px",
          "--spotlight-radius": "156px",
          "--spotlight-mask": "radial-gradient(circle, black, transparent)",
        },
        pseudo: { content: '""', opacity: "1" },
        descendants: [
          {
            selector: ".panel-heading",
            tag: "DIV",
            className: "panel-heading",
            rect: hostRect,
            descendants: [
              {
                selector: SPOTLIGHT_DETAIL_HEADING_TARGETS[0].selector,
                tag: "H2",
                id: "detailPanelTitle",
                text: "Details",
                rect: titleRect,
                textRects: [titleRect],
                computed: { color: "rgb(0, 0, 0)", fontWeight: "700" },
              },
              {
                selector: SPOTLIGHT_DETAIL_HEADING_TARGETS[1].selector,
                tag: "SPAN",
                id: "detailModeLabel",
                text: "By channel",
                rect: modeRect,
                textRects: [modeRect],
                computed: { color: "rgb(0, 0, 0)", fontSize: "13px" },
              },
            ],
          },
          {
            selector: "#detailList",
            tag: "DIV",
            id: "detailList",
            className: "bar-list",
            rect: { x: 0, y: 100, width: 800, height: 300 },
            clientWidth: 800,
            clientHeight: 300,
            computed: { overflowY: "auto" },
            descendants: rowSpecs,
          },
        ],
      },
    ],
  });
  const host = dom.elements.find((element) => element.id === "detailPanel");
  const title = dom.elements.find((element) => element.id === "detailPanelTitle");
  const modeLabel = dom.elements.find((element) => element.id === "detailModeLabel");
  const list = dom.elements.find((element) => element.id === "detailList");
  const rows = list.children;
  const names = rows.map((row) => row.children.find((child) => child.className === "bar-label").children[0]);
  const values = rows.map((row) => row.children.find((child) => child.className === "bar-label").children[1]);
  list.scrollTop = 0;
  list.scrollLeft = 0;
  list.scrollHeight = 900;
  list.scrollWidth = 800;
  for (const element of dom.elements) {
    element.isConnected = true;
    element.scrollTop ??= 0;
    element.scrollLeft ??= 0;
  }
  host.matches = (selector) => selector === ":hover";
  const querySelectorAll = dom.sandbox.document.querySelectorAll.bind(dom.sandbox.document);
  const bySelector = new Map([
    ["#detailPanel", [host]],
    [".shell #detailPanel", [host]],
    [".shell [data-spotlight-active]", [host]],
    ["#detailPanelTitle", [title]],
    ["#detailModeLabel", [modeLabel]],
    ["#detailList", [list]],
    [SPOTLIGHT_DETAIL_HEADING_TARGETS[0].selector, [title]],
    [SPOTLIGHT_DETAIL_HEADING_TARGETS[1].selector, [modeLabel]],
    [SPOTLIGHT_DETAIL_ROW_TARGETS[0].selector, names],
    [SPOTLIGHT_DETAIL_ROW_TARGETS[1].selector, values],
  ]);
  dom.sandbox.document.querySelectorAll = (selector) => bySelector.get(selector) ?? querySelectorAll(selector);
  const baseGetComputedStyle = dom.sandbox.getComputedStyle;
  dom.sandbox.getComputedStyle = (element, pseudo = null) => {
    if (pseudo === "::after") {
      return {
        ...baseGetComputedStyle(element, pseudo),
        content: '""',
        opacity: "1",
        maskImage: "radial-gradient(circle, black, transparent)",
        webkitMaskImage: "radial-gradient(circle, black, transparent)",
        backgroundImage: "radial-gradient(circle, rgb(1, 2, 3), transparent)",
        position: "absolute",
        inset: "0px",
        zIndex: "0",
        borderRadius: "4px",
        pointerEvents: "none",
        mixBlendMode: "normal",
        filter: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        transitionProperty: "none",
        transitionDuration: "0s",
      };
    }
    return baseGetComputedStyle(element, pseudo);
  };
  for (const prop of ["innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY"]) {
    Object.defineProperty(dom.sandbox, prop, {
      configurable: true,
      get: () => dom.sandbox.window[prop],
      set: (value) => {
        dom.sandbox.window[prop] = value;
      },
    });
  }
  dom.sandbox.performance = { now: () => 1 };
  dom.sandbox.window.performance = dom.sandbox.performance;
  dom.setHitTest(
    (x, y) =>
      [...names, ...values, title, modeLabel].find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) ?? host,
  );
  return { dom, host, title, modeLabel, list, rows, names, values };
}

test("A18：VM执行实际生成的详情标题守卫并允许宿主超出视口", async (t) => {
  for (const target of SPOTLIGHT_DETAIL_HEADING_TARGETS) {
    await t.test(`${target.targetKind}的生成守卫在实际DOM替身中通过`, async () => {
      const { dom, host } = createSpotlightDetailHeadingDom();
      const harness = createActualSurfacePage(dom, {
        pixels: d8f2PixelGrid([255, 255, 255], [0, 0, 0]),
      });
      const result = await measureBrowserRoles({
        page: harness.page,
        candidate: null,
        mode: "light",
        stateId: SPOTLIGHT_DETAIL_HEADING_STATE_ID,
        roleCatalog: [
          m32Role(target.roleId, {
            states: [SPOTLIGHT_DETAIL_HEADING_STATE_ID],
            selectorsByState: { [SPOTLIGHT_DETAIL_HEADING_STATE_ID]: target.selector },
          }),
        ],
        policy: M31_POLICY,
      });
      assert.equal(result.records[0].roleId, target.roleId);
      assert.equal(result.records[0].result, "pass");
      assert.ok(harness.evaluations.includes("spotlight-detail-heading-guard"));
      assert.deepEqual(
        result.diagnostics.spotlightDetailHeadingGuards.map(({ roleId, targetKind, phase }) => [
          roleId,
          targetKind,
          phase,
        ]),
        [
          [target.roleId, target.targetKind, "baseline"],
          [target.roleId, target.targetKind, "after-hide"],
          [target.roleId, target.targetKind, "before-png"],
          [target.roleId, target.targetKind, "after-png"],
          [target.roleId, target.targetKind, "after-scan"],
          [target.roleId, target.targetKind, "after-style-restore"],
          [target.roleId, target.targetKind, "after-verify"],
          [target.roleId, target.targetKind, "after-scroll-restore"],
        ],
      );
      assert.ok(result.diagnostics.spotlightDetailHeadingGuards.every((entry) => entry.valid));
      assert.deepEqual([dom.sandbox.window.scrollX, dom.sandbox.window.scrollY], [0, 0]);
      assert.equal(host.getBoundingClientRect().width > dom.sandbox.window.innerWidth, true);
    });
  }
});

function createSpotlightDetailRowFixture({
  target = SPOTLIGHT_DETAIL_ROW_TARGETS[0],
  stateId = SPOTLIGHT_DETAIL_HEADING_STATE_ID,
  selector = target.selector,
  beforeGuard,
  failRestoreCall = null,
} = {}) {
  const detail = createSpotlightDetailHeadingDom({ detailRows: 2 });
  const harness = createActualSurfacePage(detail.dom, {
    pixels: d8f2PixelGrid([255, 255, 255], [255, 255, 255]),
  });
  const baseEvaluate = harness.page.evaluate.bind(harness.page);
  let guardCalls = 0;
  let restoreCalls = 0;
  harness.page.evaluate = async (source, argument) => {
    const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
    if (tag === "spotlight-detail-row-guard") {
      guardCalls += 1;
      beforeGuard?.(guardCalls, detail);
    }
    if (tag === "restore") {
      restoreCalls += 1;
      if (restoreCalls === failRestoreCall) {
        return {
          ok: false,
          identityValid: true,
          inlineRestored: false,
          decorationRestored: false,
          restoreErrors: ["injected row restore failure"],
        };
      }
    }
    return baseEvaluate(source, argument);
  };
  const role = m32Role(target.roleId, {
    states: [stateId],
    selectorsByState: { [stateId]: selector },
  });
  return {
    ...harness,
    ...detail,
    get guardCalls() {
      return guardCalls;
    },
    run: () =>
      measureBrowserRoles({
        page: harness.page,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [role],
        policy: M31_POLICY,
      }),
  };
}

const SPOTLIGHT_DETAIL_ROW_PHASES = [
  "baseline",
  "after-hide",
  "before-png",
  "after-png",
  "after-scan",
  "after-style-restore",
  "after-verify",
  "after-scroll-restore",
];

test("A19：VM执行实际生成的详情行守卫并逐行核验名称/数值", async (t) => {
  for (const target of SPOTLIGHT_DETAIL_ROW_TARGETS) {
    await t.test(target.targetKind, async () => {
      const fixture = createSpotlightDetailRowFixture({ target });
      const result = await fixture.run();
      assert.equal(result.records[0].roleId, target.roleId);
      assert.equal(result.records[0].result, "pass");
      const guards = result.diagnostics.spotlightDetailRowGuards;
      assert.equal(guards.length, 16);
      assert.equal(result.captures.length, 2);
      assert.deepEqual(
        guards.map(({ roleId, nodeIndex, rowIndex, targetKind, phase }) => [
          roleId,
          nodeIndex,
          rowIndex,
          targetKind,
          phase,
        ]),
        [
          ...[0, 1].flatMap((index) =>
            SPOTLIGHT_DETAIL_ROW_PHASES.slice(0, -1).map((phase) => [
              target.roleId,
              index,
              index,
              target.targetKind,
              phase,
            ]),
          ),
          ...[0, 1].map((index) => [target.roleId, index, index, target.targetKind, "after-scroll-restore"]),
        ],
      );
      for (const index of [0, 1]) {
        const nodeGuards = guards.filter((entry) => entry.nodeIndex === index);
        assert.deepEqual(
          nodeGuards.map((entry) => entry.phase),
          SPOTLIGHT_DETAIL_ROW_PHASES,
        );
        const baseline = nodeGuards.find((entry) => entry.phase === "baseline");
        const afterHide = nodeGuards.find((entry) => entry.phase === "after-hide");
        assert.notDeepEqual(
          baseline.observed.targetRect,
          guards.find((entry) => entry.nodeIndex === 1 - index && entry.phase === "baseline").observed.targetRect,
        );
        assert.notEqual(
          afterHide.observed.rows[index][target.targetKind].textFillColor,
          baseline.observed.rows[index][target.targetKind].textFillColor,
        );
      }
      assert.ok(guards.every((entry) => entry.valid));
      assert.equal(new Set(result.captures.map((capture) => capture.clip.y)).size, 2);
      assert.ok(fixture.evaluations.includes("spotlight-detail-row-guard"));
      assert.deepEqual([fixture.dom.sandbox.window.scrollX, fixture.dom.sandbox.window.scrollY], [0, 0]);
      assert.equal(fixture.list.scrollTop, 0);
    });
  }
});

test("A19：非首行身份或文字漂移使整角色证据失效", async (t) => {
  for (const [name, mutate] of [
    ["非首行文字变化", (detail) => (detail.names[1].textContent = "Changed model")],
    ["非首行身份断开", (detail) => (detail.names[1].isConnected = false)],
  ]) {
    await t.test(name, async () => {
      const fixture = createSpotlightDetailRowFixture({
        beforeGuard: (call, detail) => {
          if (call === 11) mutate(detail);
        },
      });
      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, /after-png/);
        assert.deepEqual(error.measurementEvidence.records, []);
        assert.equal(error.measurementEvidence.captures.length, 2);
        assert.ok(
          error.measurementEvidence.captures.every(
            (capture) => capture.sampleStatus === "invalidated-spotlight-detail-row-state",
          ),
        );
        return true;
      });
    });
  }
});

test("A19：列表滚动与局部裁切都拒绝固定视口测量", async (t) => {
  await t.test("隐藏后列表滚动立即拒绝且不截图", async () => {
    const fixture = createSpotlightDetailRowFixture({
      beforeGuard: (call, detail) => {
        if (call === 2) detail.list.scrollTop = 2;
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /after-hide/);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
  });
  await t.test("列表可见区裁掉第二行时拒绝且不截图", async () => {
    const fixture = createSpotlightDetailRowFixture();
    fixture.list.clientHeight = 55;
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /裁切|未完整/);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
  });
});

test("A19：仅当前文字叶可有隐藏填充变化，旁行样式漂移会拒绝", async (t) => {
  await t.test("当前叶的透明填充变化获准", async () => {
    const fixture = createSpotlightDetailRowFixture({
      beforeGuard: (call, detail) => {
        if (call === 2) detail.names[0].style.setProperty("-webkit-text-fill-color", "rgba(0, 0, 0, 0)");
      },
    });
    const result = await fixture.run();
    assert.equal(result.records[0].result, "pass");
    assert.ok(result.diagnostics.spotlightDetailRowGuards.every((entry) => entry.valid));
  });
  await t.test("旁行阴影变化立即拒绝", async () => {
    const fixture = createSpotlightDetailRowFixture({
      beforeGuard: (call, detail) => {
        if (call === 2) detail.names[1].style.setProperty("text-shadow", "0 1px rgb(0, 0, 0)");
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /after-hide|漂移/);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
  });
  await t.test("模式说明变化立即拒绝", async () => {
    const fixture = createSpotlightDetailRowFixture({
      beforeGuard: (call, detail) => {
        if (call === 2) detail.modeLabel.textContent = "Changed mode";
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /after-hide|漂移/);
      assert.equal(error.measurementEvidence.captures.length, 0);
      return true;
    });
  });
});

test("A19：近似 rawSelector 或其它状态不进入详情行守卫", async (t) => {
  await t.test("selector 仅多一个空格", async () => {
    const target = SPOTLIGHT_DETAIL_ROW_TARGETS[0];
    const fixture = createSpotlightDetailRowFixture({ target, selector: `${target.selector} ` });
    const result = await fixture.run();
    assert.equal(result.diagnostics.spotlightDetailRowGuards, undefined);
    assert.equal(fixture.evaluations.includes("spotlight-detail-row-guard"), false);
  });
  await t.test("同一角色在 dashboard-default", async () => {
    const target = SPOTLIGHT_DETAIL_ROW_TARGETS[0];
    const fixture = createSpotlightDetailRowFixture({
      target,
      stateId: "dashboard-default",
      selector: target.selector,
    });
    const result = await fixture.run();
    assert.equal(result.diagnostics.spotlightDetailRowGuards, undefined);
    assert.equal(fixture.evaluations.includes("spotlight-detail-row-guard"), false);
  });
});

test("A19：后续 PNG 或恢复失败会作废该角色先前的全部截图", async (t) => {
  await t.test("第二节点 PNG 失败", async () => {
    const fixture = createSpotlightDetailRowFixture();
    const screenshot = fixture.page.screenshot.bind(fixture.page);
    let clips = 0;
    fixture.page.screenshot = async (options) => {
      if (options.clip && ++clips === 2) throw new Error("injected second row PNG failure");
      return screenshot(options);
    };
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /second row PNG failure/);
      assert.equal(error.measurementEvidence.records.length, 0);
      assert.equal(error.measurementEvidence.captures.length, 1);
      assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-detail-row-state");
      return true;
    });
  });
  await t.test("第二节点样式恢复失败", async () => {
    const fixture = createSpotlightDetailRowFixture({ failRestoreCall: 2 });
    await assert.rejects(fixture.run(), (error) => {
      assert.ok(
        error.message.includes("样式恢复未完成") ||
          error.errors?.some((item) => item.message.includes("样式恢复未完成")),
      );
      assert.equal(error.measurementEvidence.records.length, 0);
      assert.equal(error.measurementEvidence.captures.length, 2);
      assert.ok(
        error.measurementEvidence.captures.every(
          (capture) => capture.sampleStatus === "invalidated-spotlight-detail-row-state",
        ),
      );
      return true;
    });
  });
  for (const thrownValue of [null, 0, false]) {
    await t.test(`第二节点 PNG 抛出 ${String(thrownValue)} 且 release 抛 null`, async () => {
      const fixture = createSpotlightDetailRowFixture();
      const screenshot = fixture.page.screenshot.bind(fixture.page);
      let clips = 0;
      fixture.page.screenshot = async (options) => {
        if (options.clip && ++clips === 2) throw thrownValue;
        return screenshot(options);
      };
      const evaluate = fixture.page.evaluate.bind(fixture.page);
      let restoreCalls = 0;
      let releaseCalls = 0;
      fixture.page.evaluate = async (source, argument) => {
        const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
        if (tag === "restore") restoreCalls += 1;
        if (tag === "release-attempt") {
          releaseCalls += 1;
          throw null;
        }
        return evaluate(source, argument);
      };

      await assert.rejects(fixture.run(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.doesNotMatch(error.message, /Cannot read properties/);
        assert.deepEqual(error.errors, [thrownValue, null]);
        assert.equal(error.cause, thrownValue);
        assert.equal(error.measurementEvidence.records.length, 0);
        assert.equal(error.measurementEvidence.captures.length, 1);
        assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-detail-row-state");
        assert.equal(typeof error.measurementEvidence.captures[0].sampleInvalidationReason, "string");
        return true;
      });
      assert.equal(restoreCalls, 2);
      assert.equal(releaseCalls, 1);
    });
  }
});

const SPOTLIGHT_LANGUAGE_SELECTOR =
  ".shell #languageToggle[data-spotlight-active][aria-pressed='false'] > [data-language='zh-CN'].is-selected:not(:empty)";

function loadSpotlightLanguageGuardFailure() {
  const source = readFileSync(new URL("../scripts/skin-palette/browser-measure.mjs", import.meta.url), "utf8");
  const phases = source.split("\n").find((line) => line.startsWith("const TEXT_HIDE_GUARD_PHASES = new Set("));
  const start = source.indexOf("function spotlightLanguageGuardFailure(");
  const end = source.indexOf("\nfunction costNoteLinkTextRangeSignature(", start);
  assert.ok(phases, "未找到 TEXT_HIDE_GUARD_PHASES 源");
  assert.ok(start >= 0 && end > start, "未找到语言聚光失败判定源");
  return runInNewContext(
    `${phases}\n${source.slice(start, end)}\nspotlightLanguageGuardFailure`,
    createContext({ structuredClone }),
  );
}

const spotlightLanguageGuardFailure = loadSpotlightLanguageGuardFailure();

/** C47 私有语言聚光守卫的真实页内 VM 替身；不经过 measureBrowserRoles 路由。 */
function createSpotlightLanguageDom() {
  const dom = createElementStubDom();
  const rootRect = { x: 0, y: 0, width: 1280, height: 800 };
  const scrollerRect = { x: 0, y: 0, width: 1280, height: 800 };
  const hostRect = { x: 1000, y: 20, width: 64, height: 38 };
  const zhRect = { x: 1012, y: 30, width: 14, height: 18 };
  const enRect = { x: 1038, y: 30, width: 14, height: 18 };
  const root = dom.build({
    selector: "#root",
    tag: "HTML",
    rect: rootRect,
  });
  const scroller = dom.build({
    selector: ".scroller",
    tag: "DIV",
    parentElement: root,
    rect: scrollerRect,
    clientWidth: 1280,
    clientHeight: 800,
    computed: { overflowY: "auto" },
  });
  const shell = dom.build({
    selector: ".shell",
    tag: "MAIN",
    className: "shell",
    parentElement: scroller,
    rect: scrollerRect,
  });
  const host = dom.build({
    selector: "#languageToggle",
    tag: "BUTTON",
    id: "languageToggle",
    className: "theme-toggle language-toggle",
    parentElement: shell,
    rect: hostRect,
    attributes: {
      "data-spotlight-active": "",
      "data-spotlight-static": "",
      "aria-pressed": "false",
    },
    computed: {
      display: "inline-flex",
      visibility: "visible",
      isolation: "isolate",
      position: "relative",
      opacity: "1",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "linear-gradient(145deg, rgb(240, 246, 255), rgb(226, 236, 252))",
      boxShadow: "3px 4px 7px rgb(176, 184, 196)",
      borderRadius: "13px",
      transform: "none",
      mixBlendMode: "normal",
      filter: "none",
    },
    inline: {
      "--spotlight-x": "12px",
      "--spotlight-y": "9px",
      "--spotlight-radius": "80px",
      "--spotlight-mask": "radial-gradient(circle, black, transparent)",
    },
    pseudo: { content: '""', opacity: "1" },
    descendants: [
      {
        selector: SPOTLIGHT_LANGUAGE_SELECTOR,
        tag: "SPAN",
        className: "is-selected",
        attributes: { "data-language": "zh-CN" },
        text: "文",
        rect: zhRect,
        inline: { color: "rgb(50, 82, 173)" },
      },
      {
        selector: ".language-divider",
        tag: "SPAN",
        className: "language-divider",
        text: "/",
        rect: { x: 1028, y: 31, width: 6, height: 16 },
        inline: { color: "rgb(113, 128, 150)" },
      },
      {
        selector: ".language-en",
        tag: "SPAN",
        className: "language-option",
        attributes: { "data-language": "en-US" },
        text: "A",
        rect: enRect,
        inline: { color: "rgb(113, 128, 150)" },
      },
    ],
  });
  const zh = host.children[0];
  const divider = host.children[1];
  const en = host.children[2];
  for (const element of dom.elements) {
    element.isConnected = true;
    element.scrollTop ??= 0;
    element.scrollLeft ??= 0;
  }
  scroller.scrollHeight = 1200;
  scroller.scrollWidth = 1280;
  root.clientWidth = 1280;
  root.clientHeight = 800;
  dom.sandbox.document.documentElement = root;
  dom.sandbox.document.scrollingElement = root;
  root.getBoundingClientRect = () => ({
    ...rootRect,
    left: 0,
    top: 0,
    right: rootRect.width,
    bottom: rootRect.height,
  });
  host.matches = (selector) => selector === ":hover";
  const pseudoState = {
    content: '""',
    opacity: "1",
    maskImage: "radial-gradient(circle, black, transparent)",
    webkitMaskImage: "radial-gradient(circle, black, transparent)",
    backgroundImage: "radial-gradient(circle, rgb(50, 82, 173), transparent)",
    position: "absolute",
    inset: "0px",
    zIndex: "-1",
    borderRadius: "13px",
    pointerEvents: "none",
    mixBlendMode: "normal",
    filter: "none",
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
    transitionProperty: "opacity",
    transitionDuration: "120ms",
  };
  const baseGetComputedStyle = dom.sandbox.getComputedStyle;
  dom.sandbox.getComputedStyle = (element, pseudo = null) => {
    if (pseudo === "::after") return { ...baseGetComputedStyle(element, pseudo), ...pseudoState };
    return baseGetComputedStyle(element, pseudo);
  };
  const queries = new Map([
    ["#languageToggle", [host]],
    [".shell [data-spotlight-active]", [host]],
    [SPOTLIGHT_LANGUAGE_SELECTOR, [zh]],
  ]);
  const baseQuery = dom.sandbox.document.querySelectorAll.bind(dom.sandbox.document);
  dom.sandbox.document.querySelectorAll = (selector) => queries.get(selector) ?? baseQuery(selector);
  for (const prop of ["innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY"]) {
    Object.defineProperty(dom.sandbox, prop, {
      configurable: true,
      get: () => dom.sandbox.window[prop],
      set: (value) => {
        dom.sandbox.window[prop] = value;
      },
    });
  }
  return {
    dom,
    root,
    scroller,
    shell,
    host,
    zh,
    divider,
    en,
    pseudoState,
    queries,
    runProbe: () =>
      hostValue(
        runInNewContext(
          buildProbeSource("node-probe", SPOTLIGHT_LANGUAGE_SELECTOR, null, null, true, true),
          dom.sandbox,
        ),
      ),
    runScrollBegin: () => hostValue(runInNewContext(buildProbeSource("scroll-begin"), dom.sandbox)),
    runGuard: (attemptToken) =>
      hostValue(runInNewContext(buildProbeSource("spotlight-language-guard", attemptToken), dom.sandbox)),
    runHide: (attemptToken) =>
      hostValue(
        runInNewContext(buildProbeSource("hide", SPOTLIGHT_LANGUAGE_SELECTOR, 0, "text", attemptToken), dom.sandbox),
      ),
    runRestore: (token) => hostValue(runInNewContext(buildProbeSource("restore", token), dom.sandbox)),
  };
}

const assertLanguageGuardAccepted = (observed) => {
  assert.equal(observed.identityValid, true);
  assert.equal(observed.languageHostCount, 1);
  assert.equal(observed.zhNodeCount, 1);
  assert.equal(observed.enNodeCount, 1);
  assert.equal(observed.zhLeaf, true);
  assert.equal(observed.enLeaf, true);
  assert.equal(observed.zhSelected, true);
  assert.equal(observed.enSelected, false);
  assert.equal(observed.hostSame, true);
  assert.equal(observed.hostConnected, true);
  assert.equal(observed.zhSame, true);
  assert.equal(observed.enSame, true);
  assert.equal(observed.hostIsButton, true);
  assert.equal(observed.hostHasSpotlightActive, true);
  assert.equal(observed.hostAriaPressed, "false");
  assert.equal(observed.activeHostCount, 1);
  assert.equal(observed.activeHostSame, true);
  assert.equal(observed.hovered, true);
  assert.equal(observed.targetSame, true);
};

const spotlightLanguageNode = (overrides = {}) => {
  const rect = { x: 1012, y: 30, width: 14, height: 18 };
  return probeNode(0, {
    tag: "span",
    id: "languageZh",
    className: "is-selected",
    text: "文",
    rect,
    client: { left: 0, top: 0, width: rect.width, height: rect.height },
    textRects: [rect],
    rawTextRects: [rect],
    computed: {
      ...probeNode(0).computed,
      color: "rgb(255, 255, 255)",
      textFillColor: "rgb(255, 255, 255)",
    },
    ...overrides,
  });
};

const spotlightLanguageGuardState = (node) => {
  const rangeRects = node.rawTextRects ?? node.textRects;
  const emptyDeclaration = { value: "", priority: "" };
  return {
    identityValid: true,
    reason: null,
    targetIdentityId: node.identityId,
    targetConnected: true,
    targetSame: true,
    languageHostCount: 1,
    zhNodeCount: 1,
    enNodeCount: 1,
    zhLeaf: true,
    enLeaf: true,
    zhSelected: true,
    enSelected: false,
    hostIdentityId: 40,
    currentHostIdentityId: 40,
    hostSame: true,
    hostConnected: true,
    zhSame: true,
    enSame: true,
    hostIsButton: true,
    hostHasSpotlightActive: true,
    hostHasSpotlightStatic: true,
    hostAriaPressed: "false",
    activeHostCount: 1,
    activeHostSame: true,
    hovered: true,
    targetRect: node.rect,
    hostRect: { x: 1000, y: 20, width: 64, height: 38 },
    zh: {
      identityId: node.identityId,
      connected: true,
      text: node.text,
      selected: true,
      rect: node.rect,
      rangeRects,
      color: node.computed.color,
      textFillColor: node.computed.textFillColor,
      textShadow: node.computed.textShadow,
      opacity: "1",
      display: "inline",
      visibility: "visible",
      styleAttributePresent: false,
      textFillDeclaration: emptyDeclaration,
      textShadowDeclaration: emptyDeclaration,
    },
    en: {
      identityId: node.identityId + 1,
      connected: true,
      text: "A",
      selected: false,
      rect: { x: 1038, y: 30, width: 14, height: 18 },
      rangeRects: [{ x: 1038, y: 30, width: 14, height: 18 }],
      color: "rgb(113, 128, 150)",
      textFillColor: "rgb(113, 128, 150)",
      textShadow: "none",
      opacity: "1",
      display: "inline",
      visibility: "visible",
      styleAttributePresent: false,
      textFillDeclaration: emptyDeclaration,
      textShadowDeclaration: emptyDeclaration,
    },
    viewport: { width: 1280, height: 800, dpr: 1 },
    scroll: { x: 0, y: 0 },
    root: {
      identityId: 30,
      connected: true,
      scrollTop: 0,
      scrollLeft: 0,
      clientWidth: 1280,
      clientHeight: 800,
      rect: { x: 0, y: 0, width: 1280, height: 800 },
    },
    containers: [{ identityId: 20, connected: true, top: 0, left: 0 }],
    spotlight: {
      x: "12px",
      y: "9px",
      radius: "80px",
      mask: "radial-gradient(circle, black, transparent)",
      pseudo: {
        content: '""',
        opacity: "1",
        maskImage: "radial-gradient(circle, black, transparent)",
        backgroundImage: "radial-gradient(circle, rgb(50, 82, 173), transparent)",
        position: "absolute",
        inset: "0px",
        zIndex: "-1",
        borderRadius: "13px",
        pointerEvents: "none",
        mixBlendMode: "normal",
        filter: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        transitionProperty: "opacity",
        transitionDuration: "120ms",
      },
      hostStyle: {
        display: "inline-flex",
        visibility: "visible",
        isolation: "isolate",
        position: "relative",
        opacity: "1",
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "linear-gradient(145deg, rgb(240, 246, 255), rgb(226, 236, 252))",
        boxShadow: "3px 4px 7px rgb(176, 184, 196)",
        borderRadius: "13px",
        transform: "none",
        mixBlendMode: "normal",
        filter: "none",
      },
    },
  };
};

const spotlightLanguageHideState = (state) => ({
  ...state,
  zh: {
    ...state.zh,
    textFillColor: "transparent",
    textShadow: "none",
    textFillDeclaration: { value: "transparent", priority: "" },
    textShadowDeclaration: { value: "none", priority: "" },
    styleAttributePresent: true,
  },
});

const createSpotlightLanguageFixture = ({ node = spotlightLanguageNode(), ...overrides } = {}) =>
  createHoverFixedFixture({
    node,
    stateId: "spotlight-language-selected",
    roleId: "spotlight.language-selected",
    guardTag: "spotlight-language-guard",
    guardState: spotlightLanguageGuardState(node),
    roleOverrides: { selector: SPOTLIGHT_LANGUAGE_SELECTOR },
    ...overrides,
  });

test("C47：语言聚光私有守卫在真实页内 VM 正例中固定原对象、光斑和恢复声明", () => {
  const fixture = createSpotlightLanguageDom();
  const probe = fixture.runProbe();
  assert.equal(probe.nodes.length, 1);
  fixture.runScrollBegin();
  const baseline = fixture.runGuard(probe.attemptToken);
  assertLanguageGuardAccepted(baseline);
  assert.equal(baseline.zh.text, "文");
  assert.equal(baseline.en.text, "A");
  assert.deepEqual(
    baseline.containers.map(({ top, left }) => ({ top, left })),
    [{ top: 0, left: 0 }],
  );
  assert.equal(baseline.root.scrollTop, 0);
  assert.equal(baseline.spotlight.x, "12px");
  assert.equal(baseline.spotlight.pseudo.backgroundImage.includes("rgb(50, 82, 173)"), true);
  assert.equal(spotlightLanguageGuardFailure(baseline, null, probe.nodes[0], "baseline"), null);

  const hide = fixture.runHide(probe.attemptToken);
  assert.equal(hide.ok, true);
  const afterHide = fixture.runGuard(probe.attemptToken);
  assertLanguageGuardAccepted(afterHide);
  assert.equal(afterHide.zh.textFillColor, "transparent");
  assert.equal(afterHide.zh.textShadow, "none");
  assert.equal(spotlightLanguageGuardFailure(afterHide, baseline, probe.nodes[0], "after-hide"), null);

  const restore = fixture.runRestore(hide.token);
  assert.equal(restore.ok, true);
  assert.equal(restore.inlineRestored, true);
  const afterRestore = fixture.runGuard(probe.attemptToken);
  assertLanguageGuardAccepted(afterRestore);
  assert.equal(afterRestore.zh.textFillColor, baseline.zh.textFillColor);
  assert.equal(afterRestore.zh.textShadow, baseline.zh.textShadow);
  assert.deepEqual(afterRestore.zh.textFillDeclaration, baseline.zh.textFillDeclaration);
  assert.deepEqual(afterRestore.zh.textShadowDeclaration, baseline.zh.textShadowDeclaration);
  assert.equal(spotlightLanguageGuardFailure(afterRestore, baseline, probe.nodes[0], "after-style-restore"), null);
});

test("C47：语言聚光私有守卫拒绝原对象替换", () => {
  const fixture = createSpotlightLanguageDom();
  const probe = fixture.runProbe();
  fixture.runScrollBegin();
  const baseline = fixture.runGuard(probe.attemptToken);
  const replacement = fixture.dom.build({
    selector: SPOTLIGHT_LANGUAGE_SELECTOR,
    tag: "SPAN",
    className: "is-selected",
    parentElement: fixture.host,
    attributes: { "data-language": "zh-CN" },
    text: "文",
    rect: fixture.zh.getBoundingClientRect(),
    inline: { color: "rgb(50, 82, 173)" },
  });
  replacement.isConnected = true;
  fixture.dom.replaceIn(fixture.host, fixture.zh, replacement);
  fixture.queries.set(SPOTLIGHT_LANGUAGE_SELECTOR, [replacement]);
  const observed = fixture.runGuard(probe.attemptToken);
  assert.equal(observed.identityValid, false);
  assert.match(observed.reason, /selector|换成|替换|集合/);
  assert.match(
    spotlightLanguageGuardFailure(observed, baseline, probe.nodes[0], "after-png"),
    /selector|换成|替换|集合/,
  );
});

test("C47：语言聚光私有守卫拒绝选中项切换", () => {
  const fixture = createSpotlightLanguageDom();
  const probe = fixture.runProbe();
  fixture.runScrollBegin();
  const baseline = fixture.runGuard(probe.attemptToken);
  fixture.zh.className = "";
  fixture.en.className = "is-selected";
  fixture.host.setAttribute("aria-pressed", "true");
  const observed = fixture.runGuard(probe.attemptToken);
  assert.equal(observed.zhSelected, false);
  assert.equal(observed.enSelected, true);
  assert.equal(observed.hostAriaPressed, "true");
  assert.match(spotlightLanguageGuardFailure(observed, baseline, probe.nodes[0], "after-hide"), /语言按钮|zh-CN|选中/);
});

test("C47：语言聚光私有守卫拒绝伪层与坐标漂移", () => {
  const fixture = createSpotlightLanguageDom();
  const probe = fixture.runProbe();
  fixture.runScrollBegin();
  const baseline = fixture.runGuard(probe.attemptToken);
  fixture.pseudoState.maskImage = "none";
  fixture.pseudoState.webkitMaskImage = "none";
  const pseudoDrift = fixture.runGuard(probe.attemptToken);
  assert.equal(pseudoDrift.spotlight.pseudo.maskImage, "none");
  assert.match(spotlightLanguageGuardFailure(pseudoDrift, baseline, probe.nodes[0], "after-png"), /伪元素|mask|绘制/);
  fixture.pseudoState.maskImage = "radial-gradient(circle, black, transparent)";
  fixture.pseudoState.webkitMaskImage = "radial-gradient(circle, black, transparent)";
  fixture.host.style.setProperty("--spotlight-x", "13px");
  const coordinateDrift = fixture.runGuard(probe.attemptToken);
  assert.equal(coordinateDrift.spotlight.x, "13px");
  assert.match(spotlightLanguageGuardFailure(coordinateDrift, baseline, probe.nodes[0], "after-png"), /漂移|光斑|视口/);
});

test("C47：语言聚光私有守卫拒绝恢复未回到原声明", () => {
  const fixture = createSpotlightLanguageDom();
  const probe = fixture.runProbe();
  fixture.runScrollBegin();
  const baseline = fixture.runGuard(probe.attemptToken);
  const hide = fixture.runHide(probe.attemptToken);
  assert.equal(hide.ok, true);
  const originalRemoveProperty = fixture.zh.style.removeProperty;
  fixture.zh.style.removeProperty = (property) => {
    if (property === "-webkit-text-fill-color") return;
    originalRemoveProperty(property);
  };
  const restore = fixture.runRestore(hide.token);
  assert.equal(restore.ok, true);
  assert.equal(restore.inlineRestored, false);
  assert.ok(restore.restoreErrors.some((error) => error.includes("-webkit-text-fill-color")));
  const afterRestore = fixture.runGuard(probe.attemptToken);
  assertLanguageGuardAccepted(afterRestore);
  assert.notEqual(afterRestore.zh.textFillColor, baseline.zh.textFillColor);
  assert.match(
    spotlightLanguageGuardFailure(afterRestore, baseline, probe.nodes[0], "after-style-restore"),
    /前景|恢复|漂移/,
  );
});

test("C48：精确语言角色经 measureBrowserRoles 在全部阶段保态并测出 PASS", async () => {
  const fixture = createSpotlightLanguageFixture({
    guard: (call, state) => (call >= 2 && call <= 5 ? spotlightLanguageHideState(state) : state),
  });
  const result = await fixture.run();
  const record = result.records[0];

  assert.equal(record.roleId, "spotlight.language-selected");
  assert.equal(record.stateId, "spotlight-language-selected");
  assert.equal(record.method, "browser-text-pixels");
  assert.equal(record.result, "pass");
  assert.equal(JSON.parse(record.evidence).selector, SPOTLIGHT_LANGUAGE_SELECTOR);
  assert.deepEqual(
    result.diagnostics.spotlightLanguageStateGuards.map((entry) => entry.phase),
    [
      "baseline",
      "after-hide",
      "before-png",
      "after-png",
      "after-scan",
      "after-style-restore",
      "after-verify",
      "after-scroll-restore",
    ],
  );
  assert.ok(result.diagnostics.spotlightLanguageStateGuards.every((entry) => entry.valid));
  assertHoverFixedCleanup(fixture);
});

test("C48：非精确语言合同仍拒绝进入通用文字路径", async (t) => {
  const cases = [
    ["角色", "spotlight-language-selected", { id: "spotlight.tinted-surface" }],
    ["状态", "spotlight-on", { states: ["spotlight-on"] }],
    [
      "selector",
      "spotlight-language-selected",
      {
        selector:
          ".shell #languageToggle[data-spotlight-active][aria-pressed='false'] > [data-language='zh-CN'].is-selected",
      },
    ],
    [
      "背景契约",
      "spotlight-language-selected",
      { background: { kind: "solid", color: { kind: "var", name: "--toggle-selected" } } },
    ],
  ];
  for (const [name, stateId, overrides] of cases) {
    await t.test(name, async () => {
      const page = createScriptedPage(defaultHandlers());
      const result = await measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId,
        roleCatalog: [
          m32Role("spotlight.language-selected", {
            states: [stateId],
            ...overrides,
          }),
        ],
        policy: M31_POLICY,
      });
      assert.equal(result.records[0].result, "unmeasured");
      assert.equal(result.records[0].method, "unmeasured");
      assert.match(result.records[0].reason, /叠加层|背景契约/);
      assert.equal(result.diagnostics.spotlightLanguageStateGuards, undefined);
      assert.equal(page.evaluations.includes("spotlight-language-guard"), false);
      assert.equal(page.evaluations.includes("hide"), false);
    });
  }
});

test("C48：PNG 后与扫描后的语言守卫漂移都阻断 PASS", async (t) => {
  for (const [phase, callAt] of [
    ["after-png", 4],
    ["after-scan", 5],
  ]) {
    await t.test(phase, async () => {
      const fixture = createSpotlightLanguageFixture({
        guard: (call, state) => {
          const observed = call >= 2 && call <= 5 ? spotlightLanguageHideState(state) : state;
          if (call === callAt && phase === "after-png") {
            observed.targetRect = { ...observed.targetRect, x: observed.targetRect.x + 1 };
          }
          if (call === callAt && phase === "after-scan") {
            observed.spotlight.pseudo.maskImage = "none";
          }
          return observed;
        },
      });

      await assert.rejects(fixture.run(), (error) => {
        assert.match(error.message, new RegExp(phase));
        const partial = error.measurementEvidence;
        assert.deepEqual(partial.records, []);
        assert.ok(partial.captures.length >= 1);
        assert.equal(partial.captures[0].sampleStatus, "invalidated-spotlight-language-state");
        const guard = partial.diagnostics.spotlightLanguageStateGuards.find((entry) => entry.phase === phase);
        assert.equal(guard?.valid, false);
        assert.equal(typeof guard?.observed, "object");
        return true;
      });
      assertHoverFixedCleanup(fixture);
    });
  }
});

test("C48：样式恢复失败或恢复后守卫漂移都不返回 PASS", async (t) => {
  await t.test("恢复结果未完成", async () => {
    const fixture = createSpotlightLanguageFixture({
      guard: (call, state) => (call >= 2 && call <= 5 ? spotlightLanguageHideState(state) : state),
      restore: () => ({ ok: true, inlineRestored: false }),
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /样式恢复未完成/);
      assert.deepEqual(error.measurementEvidence.records, []);
      assert.equal(error.measurementEvidence.captures[0].sampleStatus, "invalidated-spotlight-language-state");
      return true;
    });
    assertHoverFixedCleanup(fixture);
  });

  await t.test("恢复后仍保留隐藏前景", async () => {
    const fixture = createSpotlightLanguageFixture({
      guard: (call, state) => {
        if (call >= 2 && call <= 5) return spotlightLanguageHideState(state);
        if (call === 6) {
          return {
            ...state,
            zh: { ...state.zh, textFillColor: "transparent", styleAttributePresent: true },
          };
        }
        return state;
      },
    });
    await assert.rejects(fixture.run(), (error) => {
      assert.match(error.message, /after-style-restore/);
      const partial = error.measurementEvidence;
      assert.deepEqual(partial.records, []);
      assert.equal(
        partial.diagnostics.spotlightLanguageStateGuards.find((entry) => entry.phase === "after-style-restore")?.valid,
        false,
      );
      assert.equal(partial.captures[0].sampleStatus, "invalidated-spotlight-language-state");
      return true;
    });
    assertHoverFixedCleanup(fixture);
  });
});

function loadInputPlaceholderNativeLayoutResolver() {
  const source = readFileSync(new URL("../scripts/skin-palette/browser-measure.mjs", import.meta.url), "utf8");
  const stash = source.split("\n").find((line) => line.startsWith("const MEASUREMENT_STASH_GLOBAL ="));
  const start = source.indexOf("// B79 private input-placeholder native layout resolver.");
  const end = source.indexOf("export async function measureBrowserRoles(", start);
  assert.ok(stash, "未找到测量 stash 常量");
  assert.ok(start >= 0 && end > start, "未找到 B79 私有 resolver 源");
  return runInContext(
    `${stash}\n${source.slice(start, end)}\nresolveInputPlaceholderNativeLayout`,
    createContext({ AggregateError }),
  );
}

const resolveInputPlaceholderNativeLayout = loadInputPlaceholderNativeLayoutResolver();

const B79_HOST_RECT = { x: 20, y: 1035.015625, width: 180, height: 36 };
const B79_HOST_CLIENT = { left: 1, top: 1, width: 178, height: 34 };
const B79_HOST_STYLE = {
  fontSize: "14px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  lineHeight: "18px",
  paddingTop: "8px",
  paddingRight: "10px",
  paddingBottom: "8px",
  paddingLeft: "10px",
  borderTopWidth: "1px",
  borderRightWidth: "1px",
  borderBottomWidth: "1px",
  borderLeftWidth: "1px",
  direction: "ltr",
  writingMode: "horizontal-tb",
  display: "inline-block",
  visibility: "visible",
  opacity: "1",
  transform: "none",
  textFillColor: "rgb(35, 49, 60)",
  textShadow: "none",
};
const B79_PLACEHOLDER_STYLE = {
  fontSize: "14px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  lineHeight: "18px",
  display: "inline",
  visibility: "visible",
  opacity: "1",
  textFillColor: "rgb(112, 120, 128)",
  textShadow: "none",
};
const B79_NATIVE_STYLE = {
  webkitTextFillColor: "rgb(112, 120, 128)",
  textShadow: "none",
  visibility: "visible",
  opacity: "1",
};
const B79_NATIVE_PAINT_STYLE = {
  textFillColor: B79_NATIVE_STYLE.webkitTextFillColor,
  textShadow: B79_NATIVE_STYLE.textShadow,
  visibility: B79_NATIVE_STYLE.visibility,
  opacity: B79_NATIVE_STYLE.opacity,
};
const B79_EXPECTED_NODE = {
  index: 0,
  hostType: "input",
  inputType: "search",
  hasValue: false,
  hasPlaceholder: true,
  rect: { ...B79_HOST_RECT },
  client: { ...B79_HOST_CLIENT },
  computed: { fontSize: "14px", fontWeight: "400" },
};
const B79_DESCRIBED_INPUT = {
  backendNodeId: 1,
  nodeType: 1,
  nodeName: "INPUT",
  shadowRoots: [
    {
      backendNodeId: 3,
      nodeType: 11,
      nodeName: "#shadow-root",
      shadowRootType: "user-agent",
      children: [
        {
          backendNodeId: 4,
          nodeType: 1,
          nodeName: "DIV",
          children: [
            {
              backendNodeId: 5,
              nodeType: 3,
              nodeName: "#text",
              nodeValue: "搜索模型",
            },
          ],
        },
      ],
    },
  ],
};
const B79_RAW_QUAD = [31, 1044.015625, 95, 1044.015625, 95, 1061.015625, 31, 1061.015625];
function executeInputPlaceholderFunction(functionDeclaration, thisValue, args = []) {
  const fn = runInNewContext(`(${functionDeclaration})`, {});
  return structuredClone(fn.apply(thisValue, args));
}

function createInputPlaceholderResolverFixture({
  describedNode = B79_DESCRIBED_INPUT,
  quads = [B79_RAW_QUAD],
  hostStyle = B79_HOST_STYLE,
  hostStyleAfter = null,
  nativeStyleBefore = B79_NATIVE_STYLE,
  nativeStyleAfter = null,
  currentAfter = null,
  mutateAfterQuads = null,
  send,
  detach,
} = {}) {
  const calls = [];
  const executions = [];
  let phase = "before";
  let evaluateCalls = 0;
  const host = {
    tagName: "INPUT",
    type: "search",
    value: "",
    placeholder: "搜索模型",
    isConnected: true,
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: "none",
    clientLeft: B79_HOST_CLIENT.left,
    clientTop: B79_HOST_CLIENT.top,
    clientWidth: B79_HOST_CLIENT.width,
    clientHeight: B79_HOST_CLIENT.height,
    getBoundingClientRect: () => ({ ...B79_HOST_RECT }),
  };
  const nativeParent = { isConnected: true };
  const nativeText = {
    nodeType: 3,
    nodeValue: "搜索模型",
    isConnected: true,
    parentElement: nativeParent,
    getRootNode: () => ({ host }),
  };
  const view = {
    scrollX: 0,
    scrollY: 0,
    getComputedStyle(node, pseudo) {
      if (node === host && pseudo === "::placeholder") return placeholderStyle;
      if (node === host) return phase === "after" && hostStyleAfter ? hostStyleAfter : hostStyle;
      if (node === nativeParent) {
        return phase === "after" && nativeStyleAfter ? nativeStyleAfter : nativeStyleBefore;
      }
      throw new Error("unexpected getComputedStyle target");
    },
  };
  const document = {
    activeElement: host,
    defaultView: view,
    fonts: { status: "loaded" },
  };
  host.ownerDocument = document;
  nativeParent.ownerDocument = document;
  const placeholderStyle = B79_PLACEHOLDER_STYLE;
  const session = {
    async send(method, params) {
      calls.push({ method, params });
      const custom = await send?.(method, params, calls);
      if (custom !== undefined) return custom;
      if (method === "Runtime.evaluate") {
        const objectId = evaluateCalls === 0 ? "host-object" : "current-object";
        evaluateCalls += 1;
        return { result: { objectId } };
      }
      if (method === "Runtime.callFunctionOn") {
        const hostSnapshot = params.functionDeclaration.includes("sameAttemptElement");
        const value = hostSnapshot
          ? executeInputPlaceholderFunction(params.functionDeclaration, host, [
              phase === "after" && currentAfter ? currentAfter : host,
            ])
          : executeInputPlaceholderFunction(params.functionDeclaration, nativeText, [host]);
        executions.push({ kind: hostSnapshot ? "host" : "native", value });
        return { result: { value } };
      }
      if (method === "DOM.describeNode") return { node: structuredClone(describedNode) };
      if (method === "DOM.resolveNode") return { object: { objectId: "ua-text-object" } };
      if (method === "DOM.getContentQuads") {
        phase = "after";
        mutateAfterQuads?.({ host, nativeText, nativeParent });
        return { quads: structuredClone(quads) };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    async detach() {
      return detach?.();
    },
  };
  const page = {
    context: () => ({ newCDPSession: async () => session }),
  };
  return {
    calls,
    executions,
    host,
    nativeText,
    resolve: (overrides = {}) =>
      resolveInputPlaceholderNativeLayout({
        page,
        attemptToken: "a1",
        nodeIndex: 0,
        roleId: "input.placeholder",
        pseudo: "::placeholder",
        expectedNode: B79_EXPECTED_NODE,
        ...overrides,
      }),
  };
}

test("B79：私有 resolver 绑定原 UA 文本并保留 quads、offset 与原始 parent 样式", async () => {
  const fixture = createInputPlaceholderResolverFixture();
  const result = JSON.parse(JSON.stringify(await fixture.resolve()));

  assert.equal(result.status, "resolved");
  assert.equal(result.hostBackendNodeId, 1);
  assert.equal(result.backendNodeId, 5);
  assert.deepEqual(result.rawQuad, B79_RAW_QUAD);
  assert.deepEqual(result.offset, { x: 11, y: 9, width: 64, height: 17 });
  assert.deepEqual(result.identity, {
    hostBackendNodeId: 1,
    backendNodeId: 5,
    candidateKind: "exact-text",
    placeholder: "搜索模型",
    offset: { x: 11, y: 9, width: 64, height: 17 },
  });
  const expectedNativePaint = {
    backendNodeId: 5,
    nodeValue: "搜索模型",
    isConnected: true,
    rootHostIsOriginal: true,
    parentElement: {
      isConnected: true,
      style: B79_NATIVE_PAINT_STYLE,
    },
  };
  assert.deepEqual(result.nativeTextPaint, expectedNativePaint);
  assert.deepEqual(result.nativeTextPaintAfter, expectedNativePaint);
  assert.equal(fixture.executions[0].value.sameAttemptElement, true);
  assert.equal(fixture.executions[1].value.parentElement.style.textFillColor, B79_NATIVE_PAINT_STYLE.textFillColor);
  assert.equal(result.evidence.stage, "resolved");
  assert.deepEqual(result.evidence.cleanup, { objectGroupReleased: true, cdpDetached: true });
  const resolveNodes = fixture.calls.filter((call) => call.method === "DOM.resolveNode");
  assert.equal(resolveNodes.length, 2, "quads 前后都必须按原 UA 文本 backendNodeId 解析");
  assert.ok(resolveNodes.every((call) => call.params.backendNodeId === 5));
  assert.equal(
    fixture.calls.some((call) => call.method === "DOM.getBoxModel"),
    false,
  );
});

test("B79：候选缺失、非 UA 文本或不唯一时保持 unmeasured", async (t) => {
  await t.test("缺失", async () => {
    const result = await createInputPlaceholderResolverFixture({
      describedNode: { backendNodeId: 1, nodeType: 1, nodeName: "INPUT" },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /未找到唯一精确/);
  });
  await t.test("非 UA 精确文本", async () => {
    const result = await createInputPlaceholderResolverFixture({
      describedNode: {
        backendNodeId: 1,
        nodeType: 1,
        nodeName: "INPUT",
        children: [{ backendNodeId: 5, nodeType: 3, nodeName: "#text", nodeValue: "搜索模型" }],
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /非UA精确文本=1/);
  });
  await t.test("伪 placeholder 节点", async () => {
    const result = await createInputPlaceholderResolverFixture({
      describedNode: {
        backendNodeId: 1,
        nodeType: 1,
        nodeName: "INPUT",
        shadowRoots: [
          {
            nodeType: 11,
            nodeName: "#shadow-root",
            shadowRootType: "user-agent",
            children: [
              {
                backendNodeId: 5,
                nodeType: 1,
                nodeName: "DIV",
                pseudoType: "placeholder",
              },
            ],
          },
        ],
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /未找到唯一精确/);
    assert.equal(result.evidence.nativeTextPaintBefore, null);
  });
  await t.test("多个 UA 文本", async () => {
    const node = structuredClone(B79_DESCRIBED_INPUT);
    node.shadowRoots[0].children[0].children.push({
      backendNodeId: 6,
      nodeType: 3,
      nodeName: "#text",
      nodeValue: "搜索模型",
    });
    const result = await createInputPlaceholderResolverFixture({ describedNode: node }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /不唯一（2）/);
  });
});

test("B79：几何、单次快照漂移和 expectedLayout 漂移都拒绝 resolved", async (t) => {
  await t.test("多 quad", async () => {
    const result = await createInputPlaceholderResolverFixture({ quads: [B79_RAW_QUAD, B79_RAW_QUAD] }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /只返回一个 quad/);
  });
  await t.test("越出内容框", async () => {
    const result = await createInputPlaceholderResolverFixture({
      quads: [[20, 1044, 95, 1044, 95, 1061, 20, 1061]],
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /越出原 input 内容区域/);
  });
  await t.test("调用期间 host 样式漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      hostStyleAfter: { ...B79_HOST_STYLE, textShadow: "0 0 1px red" },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /读取期间.*漂移/);
  });
  await t.test("调用期间 stash 对象替换", async () => {
    const result = await createInputPlaceholderResolverFixture({ currentAfter: {} }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /stash 对象已替换/);
  });
  await t.test("quads 期间 parent lookup 漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      mutateAfterQuads({ nativeText }) {
        nativeText.parentElement = null;
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /parentElement 样式快照/);
  });
  await t.test("quads 期间 root host 漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      mutateAfterQuads({ nativeText }) {
        nativeText.getRootNode = () => ({ host: {} });
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /不再属于原 input host/);
  });
  await t.test("quads 期间 native 样式漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      nativeStyleAfter: { ...B79_NATIVE_STYLE, webkitTextFillColor: "transparent" },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /quads 期间.*parent 样式漂移/);
  });
  await t.test("quads 期间 nodeValue 漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      mutateAfterQuads({ nativeText }) {
        nativeText.nodeValue = "已变化";
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /nodeValue 已变化/);
  });
  await t.test("quads 期间连接漂移", async () => {
    const result = await createInputPlaceholderResolverFixture({
      mutateAfterQuads({ nativeText }) {
        nativeText.isConnected = false;
      },
    }).resolve();
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /脱离文档/);
  });
  for (const [name, expectedLayout, reason] of [
    [
      "host backend",
      {
        hostBackendNodeId: 9,
        backendNodeId: 5,
        placeholder: "搜索模型",
        offset: { x: 11, y: 9, width: 64, height: 17 },
      },
      /input backendNodeId 已变化/,
    ],
    [
      "文案",
      { hostBackendNodeId: 1, backendNodeId: 5, placeholder: "其他", offset: { x: 11, y: 9, width: 64, height: 17 } },
      /placeholder 文案已变化/,
    ],
    [
      "offset",
      {
        hostBackendNodeId: 1,
        backendNodeId: 5,
        placeholder: "搜索模型",
        offset: { x: 12, y: 9, width: 64, height: 17 },
      },
      /offset 已变化/,
    ],
  ]) {
    await t.test(`expectedLayout ${name}`, async () => {
      const result = await createInputPlaceholderResolverFixture().resolve({ expectedLayout });
      assert.equal(result.status, "unmeasured");
      assert.match(result.reason, reason);
    });
  }
});

test("B79：CDP 主错与 release/detach 清理错保留原值和尝试顺序", async () => {
  const primaryError = new Error("describe failed");
  const releaseError = "release failed";
  const detachError = { detach: false };
  const fixture = createInputPlaceholderResolverFixture({
    send(method) {
      if (method === "DOM.describeNode") throw primaryError;
      if (method === "Runtime.releaseObjectGroup") throw releaseError;
      return undefined;
    },
    detach() {
      throw detachError;
    },
  });
  await assert.rejects(fixture.resolve(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primaryError);
    assert.deepEqual(error.errors, [primaryError, releaseError, detachError]);
    assert.deepEqual(
      { ...error.inputPlaceholderLayoutEvidence.cleanup },
      {
        objectGroupReleased: false,
        cdpDetached: false,
      },
    );
    return true;
  });
});

const INPUT_PLACEHOLDER_NATIVE_STAGES = [
  "initial",
  "after-hide",
  "band-scroll",
  "before-png",
  "after-png",
  "after-scan",
  "restore",
  "verify",
];

function nativePlaceholderProbeNode(index, id, inputType = "search", { y = 50 } = {}) {
  const node = inputProbeNode(index, id, inputType, { hasValue: false, hasPlaceholder: true });
  node.rect = { x: 20, y, width: 180, height: 36 };
  node.client = { ...B79_HOST_CLIENT };
  node.textRects = [{ ...node.rect }];
  return node;
}

/**
 * measureBrowserRoles 的真实 native placeholder 编排替身。CDP 里的函数声明仍由
 * B79 页内源码在 vm 中执行；这里只提供可随阶段变化的 host/UA 对象与 quads。
 */
function createInputPlaceholderMeasurementPage({
  nodes,
  bandScrollY = 0,
  stageVariant = () => ({}),
  scanResponse = null,
} = {}) {
  assert.ok(Array.isArray(nodes) && nodes.length > 0, "native placeholder fixture 需要节点");
  const selectors = [];
  const stageCalls = [];
  const scroll = { x: 0, y: 0 };
  let stageIndex = 0;
  let attempt = 0;
  let currentStage = null;
  let nextNativeStage = null;
  let hidden = false;
  let releaseCalls = 0;

  const shiftedRect = (rect) => ({
    ...rect,
    x: rect.x - scroll.x,
    y: rect.y - scroll.y,
  });
  const nodeAt = (index) => {
    const source = nodes[index];
    if (!source) return null;
    return {
      ...source,
      rect: shiftedRect(source.rect),
      textRects: Array.isArray(source.textRects) ? source.textRects.map(shiftedRect) : [],
      computed: { ...source.computed },
      pseudo: source.pseudo ? { ...source.pseudo } : null,
      chain: Array.isArray(source.chain) ? source.chain.map((entry) => ({ ...entry })) : [],
      scroll: { ...scroll },
    };
  };
  const activeNode = () => nodeAt(0);
  const baseHostStyle = () => {
    const node = nodes[0];
    return {
      ...B79_HOST_STYLE,
      fontSize: node.computed.fontSize,
      fontWeight: node.computed.fontWeight,
      webkitTextFillColor: B79_HOST_STYLE.textFillColor,
    };
  };
  const basePlaceholderStyle = () => {
    const node = nodes[0];
    return {
      ...B79_PLACEHOLDER_STYLE,
      fontSize: node.pseudo?.fontSize ?? node.computed.fontSize,
      fontWeight: node.computed.fontWeight,
      webkitTextFillColor: node.pseudo?.textFillColor || node.pseudo?.color || "rgb(112, 120, 128)",
    };
  };
  const stylesFor = (stage, variant) => {
    const isHidden = stage !== "initial" && stage !== "restore" && stage !== "verify";
    return {
      host: {
        ...baseHostStyle(),
        ...(isHidden ? { webkitTextFillColor: "transparent", textShadow: "none" } : {}),
        ...(variant.hostStyle ?? {}),
      },
      placeholder: {
        ...basePlaceholderStyle(),
        ...(isHidden ? { webkitTextFillColor: "transparent", textShadow: "none" } : {}),
        ...(variant.placeholderStyle ?? {}),
      },
      native: {
        ...B79_NATIVE_STYLE,
        ...(isHidden ? { webkitTextFillColor: "transparent", textShadow: "none" } : {}),
        ...(variant.nativeStyle ?? {}),
      },
    };
  };

  const host = {
    tagName: "INPUT",
    isConnected: true,
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: "none",
    get type() {
      return nodes[0].inputType;
    },
    get id() {
      return nodes[0].id;
    },
    get className() {
      return nodes[0].className;
    },
    get value() {
      return nodes[0].hasValue ? "value" : "";
    },
    get placeholder() {
      return "搜索模型";
    },
    get clientLeft() {
      return nodes[0].client.left;
    },
    get clientTop() {
      return nodes[0].client.top;
    },
    get clientWidth() {
      return nodes[0].client.width;
    },
    get clientHeight() {
      return nodes[0].client.height;
    },
    getBoundingClientRect() {
      const rect = activeNode().rect;
      const offset = currentStage?.variant?.hostRectOffset ?? { x: 0, y: 0 };
      return {
        x: rect.x + offset.x,
        y: rect.y + offset.y,
        width: rect.width,
        height: rect.height,
      };
    },
  };
  const nativeParent = { isConnected: true, ownerDocument: null };
  const nativeText = {
    nodeType: 3,
    nodeValue: "搜索模型",
    isConnected: true,
    parentElement: nativeParent,
    getRootNode: () => ({ host }),
  };
  const view = {
    get scrollX() {
      return scroll.x;
    },
    get scrollY() {
      return scroll.y;
    },
    getComputedStyle(node) {
      if (!currentStage) throw new Error("native placeholder 样式在阶段外读取");
      if (node === host) return currentStage.styles.host;
      if (node === nativeParent) return currentStage.styles.native;
      throw new Error("unexpected native placeholder style target");
    },
  };
  const document = {
    activeElement: host,
    defaultView: view,
    fonts: { status: "loaded" },
    querySelectorAll: () => [host],
  };
  host.ownerDocument = document;
  nativeParent.ownerDocument = document;
  view.getComputedStyle = (node, pseudo) => {
    if (!currentStage) throw new Error("native placeholder 样式在阶段外读取");
    if (node === host && pseudo === "::placeholder") return currentStage.styles.placeholder;
    if (node === host) return currentStage.styles.host;
    if (node === nativeParent) return currentStage.styles.native;
    throw new Error("unexpected native placeholder style target");
  };

  const describedFor = (variant) => {
    const described = structuredClone(B79_DESCRIBED_INPUT);
    if (variant.hostBackendNodeId) described.backendNodeId = variant.hostBackendNodeId;
    if (variant.candidateBackendNodeId) {
      described.shadowRoots[0].children[0].children[0].backendNodeId = variant.candidateBackendNodeId;
    }
    return described;
  };
  const quadFor = (variant) => {
    const rect = host.getBoundingClientRect();
    const offset = { x: 11, y: 9, width: 64, height: 17, ...(variant.quadOffset ?? {}) };
    return (
      variant.quad ?? [
        rect.x + offset.x,
        rect.y + offset.y,
        rect.x + offset.x + offset.width,
        rect.y + offset.y,
        rect.x + offset.x + offset.width,
        rect.y + offset.y + offset.height,
        rect.x + offset.x,
        rect.y + offset.y + offset.height,
      ]
    );
  };

  const sessionFor = (stage, attemptNumber) => {
    const variant = stageVariant(stage, { attempt: attemptNumber }) ?? {};
    currentStage = { stage, variant, styles: stylesFor(stage, variant) };
    let evaluateCalls = 0;
    const session = {
      async send(method, params) {
        if (method === "Runtime.evaluate") {
          const objectId = evaluateCalls === 0 ? "host-object" : "current-object";
          evaluateCalls += 1;
          return { result: { objectId } };
        }
        if (method === "Runtime.callFunctionOn") {
          const hostSnapshot = params.functionDeclaration.includes("sameAttemptElement");
          const value = hostSnapshot
            ? executeInputPlaceholderFunction(params.functionDeclaration, host, [host])
            : executeInputPlaceholderFunction(params.functionDeclaration, nativeText, [host]);
          return { result: { value } };
        }
        if (method === "DOM.describeNode") return { node: describedFor(variant) };
        if (method === "DOM.resolveNode") return { object: { objectId: "ua-text-object" } };
        if (method === "DOM.getContentQuads") return { quads: [quadFor(variant)] };
        if (method === "Runtime.releaseObjectGroup") return {};
        throw new Error(`unexpected native placeholder CDP method: ${method}`);
      },
      async detach() {},
    };
    return session;
  };

  const page = createScriptedPage(
    defaultHandlers({
      "node-probe": (source) => {
        const embedded = /const selector = ("(?:[^"\\]|\\.)*")/.exec(source)?.[1];
        selectors.push(embedded ? JSON.parse(embedded) : "");
        if (source.includes("const state = true ?")) {
          attempt += 1;
          stageIndex = 0;
        }
        return {
          nodes: nodes.map((_, index) => nodeAt(index)),
          attemptToken: `native-attempt-${attempt}`,
        };
      },
      "color-parse": (source) => {
        const embedded = /const value = ("(?:[^"\\]|\\.)*");/.exec(source)?.[1];
        const value = embedded ? JSON.parse(embedded) : null;
        if (value === "transparent") return { ok: true, rgb: [0, 0, 0], alpha: 0, readBack: value };
        const rgba = stubParseCssColor(value);
        if (!rgba) return { ok: false, reason: `无法解析颜色 ${String(value)}` };
        return { ok: true, rgb: rgba.slice(0, 3), alpha: rgba[3], readBack: value };
      },
      "bring-into-view": () => {
        scroll.y = bandScrollY;
        return { ok: true, scrolled: bandScrollY !== 0, scroll: { ...scroll } };
      },
      "scroll-by": (source) => {
        const embedded = /const deltaY = ([-0-9.]+);/.exec(source)?.[1];
        scroll.y += embedded ? Number(embedded) : 0;
        return { ...scroll };
      },
      "scroll-to": () => {
        scroll.y = bandScrollY;
        return { ...scroll };
      },
      "scroll-restore": () => {
        scroll.x = 0;
        scroll.y = 0;
        return { ok: true, restored: true };
      },
      "release-attempt": () => {
        releaseCalls += 1;
        hidden = false;
        scroll.x = 0;
        scroll.y = 0;
        return { ok: true, restoredTargets: 1, releasedSessions: 1, attemptReleased: true };
      },
      hide: () => {
        hidden = true;
        return {
          ok: true,
          token: `native-hide-${attempt}`,
          originals: { "-webkit-text-fill-color": "", "text-shadow": "none" },
          isolation: { isolated: true, remaining: [] },
        };
      },
      restore: () => {
        hidden = false;
        nextNativeStage = "restore";
        return { ok: true, identityValid: true, inlineRestored: true, restoreErrors: [] };
      },
      verify: () => {
        nextNativeStage = "verify";
        return {
          ok: true,
          identityValid: true,
          inlineRestored: true,
          restoreErrors: [],
          after: afterSnapshot(nodeAt(0)),
        };
      },
      scan: () => scanResponse ?? scanResult([["text-0-0", [255, 255, 255, 255]]]),
    }),
  );
  page.context = () => ({
    newCDPSession: async () => {
      const stage = nextNativeStage ?? INPUT_PLACEHOLDER_NATIVE_STAGES[stageIndex];
      assert.ok(stage, `native placeholder 阶段越界：${stageIndex}`);
      if (nextNativeStage) nextNativeStage = null;
      else stageIndex += 1;
      stageCalls.push({ attempt, stage });
      return sessionFor(stage, attempt);
    },
  });

  return {
    page,
    selectors,
    stageCalls,
    get scroll() {
      return { ...scroll };
    },
    get hidden() {
      return hidden;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    run: () =>
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId: "dashboard-default",
        roleCatalog: [m32Role("input.placeholder")],
        policy: M31_POLICY,
      }),
  };
}

test("A66/B80：native placeholder 从离屏滚入后绑定原 UA 几何并保留八阶段", async () => {
  const fixture = createInputPlaceholderMeasurementPage({
    nodes: [nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 1035.015625 })],
    bandScrollY: 735,
  });
  const result = await fixture.run();
  const record = result.records[0];
  assert.equal(record.result, "pass", record.reason);

  const evidence = JSON.parse(record.evidence);
  const native = evidence.nodes[0].nativePlaceholder;
  assert.equal(native.stages[0].source, "cdp-ua-placeholder-quads");
  assert.deepEqual(
    native.stages.map((stage) => stage.phase),
    INPUT_PLACEHOLDER_NATIVE_STAGES,
  );
  assert.deepEqual(
    fixture.stageCalls.map(({ stage }) => stage),
    INPUT_PLACEHOLDER_NATIVE_STAGES,
  );
  assert.ok(
    native.stages.every(
      (stage) =>
        stage.source === "cdp-ua-placeholder-quads" &&
        stage.status === "resolved" &&
        stage.hostBackendNodeId === 1 &&
        stage.backendNodeId === 5 &&
        stage.resolverEvidence.before.sameAttemptElement === true &&
        stage.resolverEvidence.before.connected === true &&
        stage.resolverEvidence.before.focused === true &&
        stage.resolverEvidence.before.value === "" &&
        stage.resolverEvidence.before.selectionStart === 0 &&
        stage.resolverEvidence.before.selectionEnd === 0,
    ),
    "每个阶段都必须重新绑定同一 host/UA 节点和输入状态",
  );
  assert.deepEqual(
    native.stages.map((stage) => stage.offset),
    INPUT_PLACEHOLDER_NATIVE_STAGES.map(() => ({ x: 11, y: 9, width: 64, height: 17 })),
  );
  assert.equal(native.stages[0].rect.y, 309.015625);
  assert.equal(native.stages[1].rect.y, 309.015625);
  assert.equal(native.stages[2].resolverEvidence.before.rect.y, 300.015625);
  assert.equal(native.stages[2].resolverEvidence.before.scroll.y, 735);
  assert.equal(native.stages[2].rect.y, 309.015625);
  assert.ok(native.stages.slice(2).every((stage) => stage.rect.y === 309.015625));
  assert.deepEqual(
    native.stages.slice(2).map((stage) => stage.resolverEvidence.before.rect.y),
    Array(6).fill(300.015625),
    "restore/verify 必须使用滚入视口后的 live rect，而不是调用前离屏 y=1035",
  );

  const clips = fixture.page.screenshots.filter((screenshot) => screenshot.clip).map((screenshot) => screenshot.clip);
  assert.ok(clips.length > 0);
  assert.ok(
    clips.every((clip) => JSON.stringify(clip) === JSON.stringify({ x: 31, y: 309.015625, width: 64, height: 17 })),
    "背景截图必须等于 native UA 文字矩形",
  );
  assert.notDeepEqual(clips[0], { x: 21, y: 301.015625, width: 178, height: 34 });
  assert.equal(fixture.hidden, false);
  assert.deepEqual(fixture.scroll, { x: 0, y: 0 });
});

test("C53：native placeholder 解码后隔离失效保留当前PNG与拒测节点证据", async () => {
  const isolationReason = "隐藏后仍检测到文字绘制（UA 保留独立文字填充/阴影）";
  const fixture = createInputPlaceholderMeasurementPage({
    nodes: [nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 50 })],
    scanResponse: {
      ...scanResult([["text-0-0", [69, 86, 102, 255]]]),
      identityValid: true,
      isolationValid: false,
      isolationReason,
    },
  });
  const result = await fixture.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);
  const node = evidence.nodes[0];
  const band = node.bands[0];
  const capture = result.captures[band.capture];

  assert.equal(record.result, "unmeasured");
  assert.equal(record.ratio, null);
  assert.equal(evidence.measuredCount, 0);
  assert.equal(evidence.unmeasuredCount, 1);
  assert.match(node.rejectedReason, /像素扫描时/);
  assert.match(node.rejectedReason, new RegExp(isolationReason));
  assert.equal(Number.isInteger(band.capture), true);
  assert.match(band.rejected, new RegExp(isolationReason));
  assert.equal(band.worst, undefined);
  assert.equal(capture.sampleStatus, "invalidated-input-placeholder-native");
  assert.match(capture.sampleInvalidationReason, new RegExp(isolationReason));
  assert.equal(fixture.hidden, false);
});

test("A66/B80：after-hide 拒绝原 UA 可见与字体漂移", async (t) => {
  for (const [name, variant, reason] of [
    [
      "原 UA fill 仍可见",
      { nativeStyle: { webkitTextFillColor: B79_NATIVE_STYLE.webkitTextFillColor } },
      /原 UA placeholder fill 未透明/,
    ],
    ["字体漂移但 quad 不变", { hostStyle: { fontFamily: "serif" } }, /身份、布局、焦点或文本状态漂移/],
  ]) {
    await t.test(name, async () => {
      const fixture = createInputPlaceholderMeasurementPage({
        nodes: [nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 50 })],
        stageVariant: (stage) => (stage === "after-hide" ? variant : {}),
      });
      const result = await fixture.run();
      const record = result.records[0];
      const evidence = JSON.parse(record.evidence);
      assert.equal(record.result, "unmeasured");
      assert.equal(evidence.sampleInvalid, true);
      assert.equal(evidence.attempts, 2);
      assert.equal(evidence.nativePlaceholder.phase, "after-hide");
      assert.match(evidence.nativePlaceholder.failure, reason);
      assert.deepEqual(
        fixture.stageCalls.map(({ attempt, stage }) => [attempt, stage]),
        [
          [1, "initial"],
          [1, "after-hide"],
          [2, "initial"],
          [2, "after-hide"],
        ],
      );
      if (name === "字体漂移但 quad 不变") {
        assert.equal(evidence.nativePlaceholder.resolverEvidence.before.style.fontFamily, "serif");
        assert.deepEqual(evidence.nativePlaceholder.rawQuad, [31, 59, 95, 59, 95, 76, 31, 76]);
      }
      assert.equal(fixture.releaseCalls, 2, "两次 after-hide 失败都必须执行 releaseAttempt 补恢复");
      assert.equal(fixture.hidden, false, "releaseAttempt 必须恢复隐藏目标");
    });
  }
});

test("A66/B80：后端身份或 native offset 漂移不得沿用旧几何", async (t) => {
  for (const [name, variant, reason] of [
    ["host backendNodeId 漂移", { hostBackendNodeId: 9 }, /input backendNodeId 已变化/],
    ["native offset 漂移", { quadOffset: { width: 63 } }, /host-relative offset 已变化/],
  ]) {
    await t.test(name, async () => {
      const fixture = createInputPlaceholderMeasurementPage({
        nodes: [nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 50 })],
        stageVariant: (stage) => (stage === "after-png" ? variant : {}),
      });
      const result = await fixture.run();
      const record = result.records[0];
      const evidence = JSON.parse(record.evidence);
      assert.equal(record.result, "unmeasured");
      assert.equal(evidence.sampleInvalid, true);
      assert.equal(evidence.attempts, 2);
      assert.equal(evidence.nativePlaceholder.phase, "after-png");
      assert.match(evidence.nativePlaceholder.reason, reason);
      const invalidated = result.captures.filter(
        (capture) => capture.kind === "background" && capture.sampleInvalidationReason,
      );
      assert.ok(invalidated.length >= 1, "已产生的背景 PNG 必须保留失效标记");
      assert.ok(invalidated.every((capture) => /^invalidated-/.test(capture.sampleStatus)));
      assert.ok(invalidated.some((capture) => capture.sampleInvalidationReason.includes("after-png")));
    });
  }
});

test("A66/B80：after-scan 与 restore 漂移保留 partial、失效截图和撤样记录", async (t) => {
  for (const [name, stage, variant, reason] of [
    ["after-scan 几何漂移", "after-scan", { hostRectOffset: { x: 0, y: 1 } }, /几何与调用参数不一致/],
    [
      "restore 仍保持透明",
      "restore",
      { nativeStyle: { webkitTextFillColor: "transparent" } },
      /原 UA placeholder paint 未恢复/,
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = createInputPlaceholderMeasurementPage({
        nodes: [nativePlaceholderProbeNode(0, "modelComparisonSearch", "search", { y: 50 })],
        stageVariant: (candidate) => (candidate === stage ? variant : {}),
      });
      const result = await fixture.run();
      const record = result.records[0];
      const evidence = JSON.parse(record.evidence);
      assert.equal(record.result, "unmeasured");
      assert.equal(evidence.sampleInvalid, true);
      assert.equal(evidence.attempts, 2);
      assert.equal(evidence.nativePlaceholder.phase, stage);
      assert.match(evidence.nativePlaceholder.reason ?? evidence.nativePlaceholder.failure, reason);
      assert.ok(
        fixture.stageCalls.some((call) => call.stage === stage),
        `${stage} 阶段必须留下原始调用记录`,
      );
      const invalidated = result.captures.filter(
        (capture) => capture.kind === "background" && capture.sampleInvalidationReason,
      );
      assert.ok(invalidated.length >= 1, "失败前生成的背景 PNG 不得被当作有效证据");
      assert.ok(invalidated.every((capture) => /^invalidated-/.test(capture.sampleStatus)));
      assert.ok(invalidated.some((capture) => capture.sampleInvalidationReason.includes(stage)));
    });
  }
});
