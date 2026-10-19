/**
 * M2 skin-palette solver/template acceptance tests (node --test).
 *
 * M2.1 anchors: the task card's fixed tables (surface template, a/b/c
 * variants, correction order and clamps, foreground ranges) plus M1.3 colour
 * math for independent recomputation; degenerate profiles exercise the
 * clamp/dedupe paths. No random input, no filesystem beyond reading the
 * module source for the purity scan.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SKIN_IDS,
  VARIANTS,
  canonicalFileContent,
  canonicalJson,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  validateCandidate,
  validateCandidateSet,
  validateFailureRecord,
} from "../scripts/skin-palette/contracts.mjs";
import {
  GENERATE_EXIT_CODES,
  GenerateCliError,
  parseGenerateArgs,
  resolveGenerateOutputDirectory,
  runGenerate,
} from "../scripts/skin-palette/generate-cli.mjs";
import { generateCandidates } from "../scripts/skin-palette/generate.mjs";
import { evaluatePalette } from "../scripts/skin-palette/evaluate.mjs";
import { ROLE_CATALOG } from "../scripts/skin-palette/roles.mjs";

import {
  ACCENT_MIN_C,
  L_LIMITS,
  SURFACE_C_LIMIT,
  TEMPLATE_STAGE,
  VARIANT_IDS,
  buildSurfaceTemplates,
} from "../scripts/skin-palette/templates.mjs";
import { SOLVE_ORDER, SOLVE_STATUS, solveModeForegrounds } from "../scripts/skin-palette/solver.mjs";
import {
  compositeSrgb,
  contrastRatio,
  fitSrgbGamut,
  hexToSrgb,
  okDistance,
  oklabToOklch,
  srgbToHex,
  srgbToOklab,
} from "../scripts/skin-palette/color-math.mjs";

const HEX_RE = /^#[0-9A-F]{6}$/;
const closeTo = (actual, expected, epsilon, label) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} vs ${expected}`);
const closeToList = (actual, expected, epsilon, label) => {
  assert.equal(actual.length, expected.length, `${label}: 长度`);
  actual.forEach((value, index) => {
    closeTo(value, expected[index], epsilon, `${label}[${index}]`);
  });
};

const BASE_PROFILE = {
  identityHex: "#4F4971",
  surfaceH: 268,
  surfaceC: 0.028,
  pageL: { light: 0.93, dark: 0.17 },
  accentC: 0.1,
};
const M52_T1_PROFILE = Object.freeze({
  identityHex: "#607EC7",
  surfaceH: 260,
  surfaceC: 0.025,
  pageL: Object.freeze({ light: 0.94, dark: 0.22 }),
  accentC: 0.15,
});
const M52_T1_POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

const BACKGROUND_TOKENS = [
  "pageBackground",
  "panelBackground",
  "panelHighlight",
  "panelShadow",
  "panelBorder",
  "controlBackground",
];

test("M2.1：a/b/c × light/dark 全部产出完整模式模板（草案标记、六表面 token、大写 HEX、深冻结）", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  assert.equal(templates.stage, TEMPLATE_STAGE);
  assert.deepEqual(Object.keys(templates.variants).sort(), [...VARIANT_IDS].sort());
  for (const id of VARIANT_IDS) {
    for (const mode of ["light", "dark"]) {
      const { corrections, foregrounds } = templates.variants[id].modes[mode];
      assert.ok(corrections.length >= 1 && corrections.length <= 3, `${id}/${mode} 修正组数须在 1..3`);
      for (const group of corrections) {
        for (const name of BACKGROUND_TOKENS) {
          assert.match(group.backgrounds[name], HEX_RE, `${id}/${mode} ${name} 须为大写 #RRGGBB`);
        }
        assert.equal(group.backgrounds.controlBackground, group.backgrounds.panelBackground);
        for (const name of BACKGROUND_TOKENS) {
          assert.equal(typeof group.gamut[name].chromaReduced, "boolean", `${id}/${mode} ${name} gamut 记录`);
        }
      }
      for (const key of ["textPrimary", "textSecondary", "chartText", "accent"]) {
        const spec = foregrounds[key];
        assert.ok(Number.isFinite(spec.startL), `${id}/${mode} ${key} startL`);
        assert.ok(spec.lMin < spec.lMax, `${id}/${mode} ${key} L 范围`);
        assert.ok(Number.isFinite(spec.hue), `${id}/${mode} ${key} hue`);
      }
    }
  }
  assert.ok(Object.isFrozen(templates));
  assert.ok(Object.isFrozen(templates.variants.a.modes.light.corrections[0].backgrounds));
  assert.ok(Object.isFrozen(templates.variants.a.modes.light.foregrounds.textPrimary));
});

test("M2.1：同一配方重复调用输出深度相等（纯函数可复现）", () => {
  assert.deepEqual(buildSurfaceTemplates(BASE_PROFILE), buildSurfaceTemplates(BASE_PROFILE));
});

test("M2.1：修正组按固定顺序枚举，pageL 数值与变体偏移吻合；b 深色 −0.045 触界钳制到 −0.04", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  const pageLs = (id, mode) => templates.variants[id].modes[mode].corrections.map((group) => group.pageL);
  closeToList(pageLs("a", "light"), [0.93, 0.95, 0.91], 1e-9, "a light pageL");
  closeToList(pageLs("a", "dark"), [0.17, 0.15, 0.19], 1e-9, "a dark pageL");
  closeToList(pageLs("b", "light"), [0.945, 0.965, 0.925], 1e-9, "b light pageL");
  closeToList(pageLs("c", "light"), [0.915, 0.935, 0.895], 1e-9, "c light pageL");
  closeToList(pageLs("c", "dark"), [0.185, 0.165, 0.205], 1e-9, "c dark pageL");
  // b dark：0/−0.020/+0.020 叠加 −0.025 → 请求偏移 −0.045 越界钳制，其余组不触界
  const bDark = templates.variants.b.modes.dark.corrections;
  closeToList(pageLs("b", "dark"), [0.145, 0.13, 0.165], 1e-9, "b dark pageL");
  assert.equal(bDark[0].offsetClamped, false);
  assert.equal(bDark[1].requestedPageLOffset, -0.045);
  assert.equal(bDark[1].pageLOffset, -0.04);
  assert.equal(bDark[1].offsetClamped, true);
  assert.equal(bDark[2].offsetClamped, false);
  for (const id of VARIANT_IDS) {
    for (const mode of ["light", "dark"]) {
      templates.variants[id].modes[mode].corrections.forEach((group, index) => {
        assert.equal(group.index, index, `${id}/${mode} 修正组索引保持枚举顺序`);
      });
    }
  }
});

test("M2.1：表面 token 按卡面表构造——用 M1.3 原语独立重算锚定（a 变体 light/dark 首组）", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  const C = BASE_PROFILE.surfaceC;
  const H = BASE_PROFILE.surfaceH;
  const expect = (L, c) => srgbToHex(fitSrgbGamut({ L, C: c, H }).rgb);
  const g0 = templates.variants.a.modes.light.corrections[0].backgrounds;
  assert.equal(g0.pageBackground, expect(0.93, C));
  assert.equal(g0.panelBackground, expect(0.96, 0.6 * C));
  assert.equal(g0.panelHighlight, expect(0.985, 0.25 * C));
  assert.equal(g0.panelShadow, expect(0.77, 0.75 * C));
  assert.equal(g0.panelBorder, expect(0.915, 0.4 * C));
  const d0 = templates.variants.a.modes.dark.corrections[0].backgrounds;
  assert.equal(d0.pageBackground, expect(0.17, C));
  assert.equal(d0.panelBackground, expect(0.215, 0.6 * C));
  assert.equal(d0.panelHighlight, expect(0.295, 0.25 * C));
  assert.equal(d0.panelShadow, expect(0.05, 0.75 * C));
  assert.equal(d0.panelBorder, expect(0.255, 0.4 * C));
});

test("M2.1：输出 OKLCH 关系符合模板表（L 差按卡面；H 容 8-bit 舍入与边界降 C 漂移）", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  const lchOf = (hex) => oklabToOklch(srgbToOklab(hexToSrgb(hex)));
  for (const mode of ["light", "dark"]) {
    const group = templates.variants.a.modes[mode].corrections[0];
    const page = lchOf(group.backgrounds.pageBackground);
    const panel = lchOf(group.backgrounds.panelBackground);
    const shadow = lchOf(group.backgrounds.panelShadow);
    const deltas = mode === "light" ? { panel: 0.03, shadow: 0.16 } : { panel: 0.045, shadow: 0.12 };
    closeTo(panel.L - page.L, deltas.panel, 0.004, `${mode} panelL − pageL`);
    // 暗部阴影 L≈0.05 落近黑区，8-bit 量化对 OKLab L 的放大可达 ~0.012，取 0.02 容差
    closeTo(page.L - shadow.L, deltas.shadow, 0.02, `${mode} pageL − shadowL`);
    for (const name of BACKGROUND_TOKENS) {
      const lch = lchOf(group.backgrounds[name]);
      // H 在两种区域病态：C≈0.01 时 a/b 与 8-bit 量化噪声同量级（dark panelBorder
      // C=0.010 漂 7.3°）；L<0.1 近黑区 8-bit 步长对线性通道的相对放大同样拉歪 H
      // （dark panelShadow L=0.038 漂 3.95°）。两种桶放宽到 10° 只拦色相族互换；
      // 中亮度足色度时定向可靠，仍用 3°
      closeTo(lch.H, BASE_PROFILE.surfaceH, lch.C < 0.015 || lch.L < 0.1 ? 10 : 3, `${mode} ${name} H 同 surfaceH`);
    }
  }
});

test("M2.1：前景起点/范围/H/C 按卡面表；文字 C 上限取 min(surfaceC, 0.018)，accent 随变体缩放", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  const light = templates.variants.a.modes.light.foregrounds;
  assert.equal(light.textPrimary.startL, 0.24);
  assert.equal(light.textPrimary.lMin, 0.1);
  assert.equal(light.textPrimary.lMax, 0.48);
  assert.equal(light.textSecondary.startL, 0.43);
  assert.equal(light.textSecondary.lMin, 0.12);
  assert.equal(light.textSecondary.lMax, 0.6);
  assert.equal(light.chartText.startL, 0.43);
  assert.equal(light.chartText.lMin, 0.18);
  assert.equal(light.accent.startL, 0.55);
  assert.equal(light.accent.lMin, 0.28);
  assert.equal(light.accent.lMax, 0.68);
  const dark = templates.variants.a.modes.dark.foregrounds;
  assert.equal(dark.textPrimary.startL, 0.95);
  assert.equal(dark.textPrimary.lMin, 0.78);
  assert.equal(dark.textPrimary.lMax, 0.99);
  assert.equal(dark.textSecondary.startL, 0.78);
  assert.equal(dark.accent.startL, 0.78);
  assert.equal(dark.accent.lMin, 0.62);
  assert.equal(dark.accent.lMax, 0.94);
  const identityHue = oklabToOklch(srgbToOklab(hexToSrgb(BASE_PROFILE.identityHex))).H;
  assert.equal(templates.identityHue, identityHue);
  for (const key of ["textPrimary", "textSecondary", "chartText"]) {
    assert.equal(light[key].hue, BASE_PROFILE.surfaceH);
    assert.equal(light[key].maxC, Math.min(BASE_PROFILE.surfaceC, 0.018));
    assert.equal(dark[key].hue, BASE_PROFILE.surfaceH);
  }
  assert.equal(dark.textSecondary.lMin, 0.62);
  assert.equal(light.accent.hue, identityHue);
  assert.equal(light.accent.cTarget, BASE_PROFILE.accentC);
  assert.equal(light.accent.minC, ACCENT_MIN_C);
  closeTo(templates.variants.b.modes.light.foregrounds.accent.cTarget, BASE_PROFILE.accentC * 0.9, 1e-12, "b accentC");
  closeTo(templates.variants.c.modes.light.foregrounds.accent.cTarget, BASE_PROFILE.accentC * 1.05, 1e-12, "c accentC");
  closeTo(templates.variants.b.surfaceC, BASE_PROFILE.surfaceC * 0.75, 1e-12, "b surfaceC");
  closeTo(templates.variants.c.surfaceC, BASE_PROFILE.surfaceC * 1.2, 1e-12, "c surfaceC");
  closeTo(
    templates.variants.b.modes.light.foregrounds.textPrimary.maxC,
    Math.min(BASE_PROFILE.surfaceC * 0.75, 0.018),
    1e-12,
    "b text maxC",
  );
});

test("M5.2-T1：ChatGPT 首版 a/light 用真实全角色求解满足原目标，浏览器角色仍待实测", () => {
  const template = buildSurfaceTemplates(M52_T1_PROFILE).variants.a.modes.light;
  assert.equal(template.foregrounds.textSecondary.lMin, 0.12);
  assert.equal(template.foregrounds.chartText.lMin, 0.18);

  const solved = solveModeForegrounds({
    skinId: "chatgpt",
    mode: "light",
    roleCatalog: ROLE_CATALOG,
    policy: M52_T1_POLICY,
    evaluatePalette,
    corrections: template.corrections,
    foregrounds: template.foregrounds,
  });
  assert.equal(solved.status, SOLVE_STATUS.SOLVED, JSON.stringify(solved));

  const evaluation = evaluatePalette({
    skinId: "chatgpt",
    mode: "light",
    tokens: solved.tokens,
    roleCatalog: ROLE_CATALOG,
    policy: M52_T1_POLICY,
  });
  assert.equal(evaluation.entries.length, ROLE_CATALOG.length);
  const calendarOutside = evaluation.entries.find((entry) => entry.roleId === "calendar.day-outside");
  assert.ok(calendarOutside, "完整角色目录包含 calendar.day-outside");
  assert.ok(
    calendarOutside.ratio >= M52_T1_POLICY.solver.bodyTextTarget,
    `calendar.day-outside: ${calendarOutside.ratio}`,
  );
  assert.deepEqual(
    evaluation.entries.filter((entry) => entry.required && entry.status === "fail").map((entry) => entry.roleId),
    [],
  );
  const browserRequired = evaluation.entries
    .filter((entry) => entry.status === "browser-required")
    .map((entry) => entry.roleId);
  assert.ok(browserRequired.length > 0, "快速求解不能把浏览器角色当作已实测");
  assert.deepEqual(solved.browserRequiredRoles, browserRequired);
});

test("M2.1：变体 c 触及表面 C 上限钳制并记录；pageL 触 L 下限时重复修正组去除", () => {
  const capped = buildSurfaceTemplates({ ...BASE_PROFILE, surfaceC: 0.045 });
  assert.equal(capped.variants.a.surfaceC, SURFACE_C_LIMIT.max);
  assert.equal(capped.variants.a.surfaceCClamped, false);
  assert.equal(capped.variants.b.surfaceCClamped, false);
  assert.equal(capped.variants.c.surfaceC, SURFACE_C_LIMIT.max);
  assert.equal(capped.variants.c.surfaceCClamped, true);
  assert.equal(capped.variants.a.modes.dark.corrections.length, 3);
  // 退化配方：pageL.dark=0.02，a 深色三组修正的 pageL 全部被 L 下限钳到 0.04 → 只留首组
  const degenerate = buildSurfaceTemplates({ ...BASE_PROFILE, pageL: { light: 0.93, dark: 0.02 } });
  const groups = degenerate.variants.a.modes.dark.corrections;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pageL, L_LIMITS.min);
  assert.equal(groups[0].lClamped, true);
  assert.equal(groups[0].offsetClamped, false);
});

test("M2.1：小于去重键粒度（1e-9）的越界也如实标记钳制（标记按值变更判定，不按量化键）", () => {
  // pageL.dark 触 L 下限，越界幅度 1e-12 < 键粒度 1e-9：值确被钳到边界，lClamped 必须为 true
  const tinyOverrun = buildSurfaceTemplates({
    ...BASE_PROFILE,
    pageL: { light: 0.93, dark: L_LIMITS.min - 1e-12 },
  });
  const darkGroups = tinyOverrun.variants.a.modes.dark.corrections;
  assert.equal(darkGroups.length, 2);
  assert.equal(darkGroups[0].pageL, L_LIMITS.min);
  assert.equal(darkGroups[0].lClamped, true);
  assert.equal(darkGroups[0].offsetClamped, false);
  assert.equal(darkGroups[1].lClamped, false);
  // surfaceC 触上限同理（变体 a 缩放系数 1，1e-12 越界 → 钳到 0.045）
  const cappedTiny = buildSurfaceTemplates({ ...BASE_PROFILE, surfaceC: SURFACE_C_LIMIT.max + 1e-12 });
  assert.equal(cappedTiny.variants.a.surfaceC, SURFACE_C_LIMIT.max);
  assert.equal(cappedTiny.variants.a.surfaceCClamped, true);
  assert.equal(cappedTiny.variants.b.surfaceCClamped, false);
  assert.equal(cappedTiny.variants.c.surfaceCClamped, true);
});

test("M2.1：gamut 修正记录保留——记录与输出一致；近白高光超域与高 C 浅蓝超域都如实降 C", () => {
  const templates = buildSurfaceTemplates(BASE_PROFILE);
  const lchOf = (hex) => oklabToOklch(srgbToOklab(hexToSrgb(hex)));
  for (const mode of ["light", "dark"]) {
    for (const group of templates.variants.a.modes[mode].corrections) {
      for (const [name, record] of Object.entries(group.gamut)) {
        // 记录与最终 HEX 一致：降 C 时 finalC < requestedC，域内时相等
        if (record.chromaReduced) {
          assert.ok(record.finalC < record.requestedC, `${mode}/${name} 降 C 记录`);
        } else {
          closeTo(record.finalC, record.requestedC, 1e-9, `${mode}/${name} finalC`);
        }
        // 近黑区（L≈0.05）8-bit 量化对 OKLab L 的放大可达 ~0.012，取 0.02 容差
        closeTo(record.finalL, lchOf(group.backgrounds[name]).L, 0.02, `${mode}/${name} finalL 与 HEX 一致`);
      }
    }
  }
  // 结构性期望：浅色高光 L=pageL+0.055 贴近白点，C=0.25×0.028 超出 sRGB 可承载色度——
  // 必然走降 C 路径（记录必须如实反映，而不是悄悄裁剪后声称未变）；其余 token 域内。
  assert.equal(templates.variants.a.modes.light.corrections[0].gamut.panelHighlight.chromaReduced, true);
  assert.equal(templates.variants.a.modes.light.corrections[0].gamut.pageBackground.chromaReduced, false);
  assert.equal(templates.variants.a.modes.dark.corrections[0].gamut.panelHighlight.chromaReduced, false);
  // 高 C 浅蓝：pageBackground 自身超域（黄绿 H130 在高 L 反而色域极宽、仍在域内，
  // 故反例取 H250），降 C 后 HEX 仍为合法大写输出
  const blue = buildSurfaceTemplates({
    ...BASE_PROFILE,
    surfaceH: 250,
    surfaceC: 0.045,
    pageL: { light: 0.95, dark: 0.2 },
  });
  const record = blue.variants.a.modes.light.corrections[0].gamut.pageBackground;
  assert.equal(record.chromaReduced, true);
  assert.ok(record.finalC < record.requestedC, `超域须降 C：${record.finalC} < ${record.requestedC}`);
  assert.match(blue.variants.a.modes.light.corrections[0].backgrounds.pageBackground, HEX_RE);
});

test("M2.1：非法配方显式报错", () => {
  assert.throws(() => buildSurfaceTemplates(null), /配方对象/);
  assert.throws(() => buildSurfaceTemplates("nope"), /配方对象/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, identityHex: 5 }), /identityHex/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, identityHex: "#12g456" }), /无法解析/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, surfaceH: Number.NaN }), /surfaceH/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, surfaceC: "0.02" }), /surfaceC/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, accentC: Number.POSITIVE_INFINITY }), /accentC/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, pageL: { light: 0.9 } }), /pageL\.dark/);
  assert.throws(() => buildSurfaceTemplates({ ...BASE_PROFILE, pageL: null }), /pageL/);
});

test("M2.1：模块纯度——只依赖 color-math，无文件/DOM/随机/时间访问", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/templates.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s+[^;]+?from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./color-math.mjs"]);
  for (const banned of ["readFile", "writeFile", "document", "window", "Math.random", "Date.now", "process."]) {
    assert.ok(!source.includes(banned), `模板模块不得出现 ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// M2.2 有界前景求解（solver.mjs）
// ---------------------------------------------------------------------------

const M22_POLICY = {
  readability: { bodyTextMin: 4.5 },
  solver: { primaryTextTarget: 7.2, bodyTextTarget: 4.7 },
  searchBudget: { maxTrialsPerTokenPerRound: 1024, maxCouplingRounds: 4, maxBackgroundAttemptsPerVariant: 3 },
};

const M22_BASE_TEMPLATES = buildSurfaceTemplates(BASE_PROFILE);
const LIGHT_CORRECTIONS = M22_BASE_TEMPLATES.variants.a.modes.light.corrections;
const LIGHT_FOREGROUNDS = M22_BASE_TEMPLATES.variants.a.modes.light.foregrounds;
const DARK_CORRECTIONS = M22_BASE_TEMPLATES.variants.a.modes.dark.corrections;
const DARK_FOREGROUNDS = M22_BASE_TEMPLATES.variants.a.modes.dark.foregrounds;
const LIGHT_PANEL = LIGHT_CORRECTIONS[0].backgrounds.panelBackground;
const DARK_PANEL = DARK_CORRECTIONS[0].backgrounds.panelBackground;

/** 规格网格坐标 → 试值 HEX（测试装置构造自定义背景/断言用）。 */
const hexAt = (L, C, H) => srgbToHex(fitSrgbGamut({ L, C, H }).rgb);
const decodedL = (hex) => oklabToOklch(srgbToOklab(hexToSrgb(hex))).L;

/**
 * 人造角色评估器：角色表 → evaluatePalette 契约实现。阈值语义属于角色表（测试
 * 装置自身），不复制求解器内部公式；比值可来自 M1.3 contrastRatio，也可来自
 * 纯 L 判定式（制造非单调/多段形态）。
 */
const syntheticEvaluate =
  (roles) =>
  ({ tokens }) => ({
    entries: roles.map((role) => {
      const measured = role.effective(tokens);
      const status = measured.status ?? (measured.ratio >= role.threshold ? "pass" : "fail");
      return {
        roleId: role.id,
        required: role.required !== false,
        status,
        ratio: measured.ratio ?? null,
        threshold: role.threshold ?? null,
        foregroundTokens: role.foregroundTokens ?? [],
        backgroundTokens: role.backgroundTokens ?? [],
      };
    }),
  });

const contrastRole = (id, threshold, fgOf, bgOf, deps) => ({
  id,
  threshold,
  effective: (tokens) => ({ ratio: contrastRatio(fgOf(tokens), bgOf(tokens)) }),
  foregroundTokens: deps.fg ?? [],
  backgroundTokens: deps.bg ?? [],
});

const SOLVE_OPTIONS = {
  skinId: "fixture-skin",
  roleCatalog: { synthetic: true },
};

test("M2.2：单角色基线——SOLVED、12 token 完整、镜像控制 token、确定性、预算内", () => {
  const roles = [
    contrastRole(
      "panel.metric",
      4.5,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  let seenRequest = null;
  const evaluate = (request) => {
    seenRequest = request;
    return syntheticEvaluate(roles)(request);
  };
  const solve = () =>
    solveModeForegrounds({
      ...SOLVE_OPTIONS,
      mode: "light",
      policy: M22_POLICY,
      evaluatePalette: evaluate,
      corrections: LIGHT_CORRECTIONS,
      foregrounds: LIGHT_FOREGROUNDS,
    });
  const result = solve();
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  const tokens = result.tokens;
  assert.deepEqual(
    Object.keys(tokens).sort(),
    [
      ...["pageBackground", "panelBackground", "panelHighlight", "panelShadow", "panelBorder", "controlBackground"],
      ...SOLVE_ORDER,
      "controlText",
      "controlBorder",
    ].sort(),
  );
  for (const value of Object.values(tokens)) assert.match(value, HEX_RE);
  assert.equal(tokens.controlText, tokens.textPrimary);
  assert.equal(tokens.controlBorder, tokens.panelBorder);
  // 评估器收到完整契约请求
  assert.equal(seenRequest.skinId, "fixture-skin");
  assert.equal(seenRequest.mode, "light");
  assert.deepEqual(Object.keys(seenRequest.tokens).sort(), Object.keys(tokens).sort());
  assert.equal(seenRequest.roleCatalog, SOLVE_OPTIONS.roleCatalog);
  assert.equal(seenRequest.policy, M22_POLICY);
  assert.equal(result.preferredContrastUnmet, false);
  assert.equal(result.roundsUsed, 1);
  assert.ok(result.roundsUsed <= M22_POLICY.searchBudget.maxCouplingRounds);
  for (const used of Object.values(result.trials.byToken)) {
    assert.ok(used <= M22_POLICY.searchBudget.maxTrialsPerTokenPerRound, `预算内：${used}`);
  }
  const tp = result.solvedTokens.textPrimary;
  assert.ok(tp.finalL > LIGHT_FOREGROUNDS.textPrimary.lMin - 0.02, "实现 L 不低于下限（容量化漂移）");
  assert.ok(tp.finalC <= LIGHT_FOREGROUNDS.textPrimary.maxC + 0.001, "实现 C 不超目标 C（容 8-bit 量化漂移）");
  assert.deepEqual(solve(), result, "同一配方重复求解深度相等");
});

test("M2.2：主文字 7.2 优选；范围受限时降 4.7 并记录 preferredContrastUnmet（不重复网格）", () => {
  const roles = [
    contrastRole(
      "panel.metric",
      4.5,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  const base = {
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
  };
  // (a) 全范围：7.2 可达（实测 L0.10 处 ~18.4），必须按 7.2 选中
  const full = solveModeForegrounds({ ...base, foregrounds: LIGHT_FOREGROUNDS });
  assert.equal(full.status, SOLVE_STATUS.SOLVED);
  assert.equal(full.preferredContrastUnmet, false);
  assert.ok(contrastRatio(full.tokens.textPrimary, LIGHT_PANEL) >= 7.2, "选中点达 7.2 优选");
  // (b) 范围钳到 [0.44, 0.48]：最高 ~6.98 < 7.2 但 ≥ 4.7 → 回退并记录
  const constrained = {
    ...LIGHT_FOREGROUNDS,
    textPrimary: { ...LIGHT_FOREGROUNDS.textPrimary, startL: 0.46, lMin: 0.44, lMax: 0.48 },
  };
  const fallback = solveModeForegrounds({ ...base, foregrounds: constrained });
  assert.equal(fallback.status, SOLVE_STATUS.SOLVED);
  assert.equal(fallback.preferredContrastUnmet, true);
  const ratio = contrastRatio(fallback.tokens.textPrimary, LIGHT_PANEL);
  assert.ok(ratio >= 4.7, `回退后仍达 4.7：${ratio.toFixed(3)}`);
  assert.ok(ratio < 7.2, `范围内确实无 7.2 可行点：${ratio.toFixed(3)}`);
});

test("M2.2：多背景同时约束——同一 token 的角色分布在两个背景上，选中点须全部满足", () => {
  const darkerControl = hexAt(0.85, 0.017, 268);
  const corrections = [
    {
      ...LIGHT_CORRECTIONS[0],
      backgrounds: { ...LIGHT_CORRECTIONS[0].backgrounds, controlBackground: darkerControl },
    },
  ];
  const roles = [
    contrastRole(
      "panel.metric",
      4.5,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
    contrastRole(
      "control.label",
      4.5,
      (t) => t.textPrimary,
      (t) => t.controlBackground,
      {
        fg: ["textPrimary"],
        bg: ["controlBackground"],
      },
    ),
  ];
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  assert.ok(contrastRatio(result.tokens.textPrimary, LIGHT_PANEL) >= 7.2, "面板底达 7.2");
  assert.ok(contrastRatio(result.tokens.textPrimary, darkerControl) >= 7.2, "更暗控件底同时达 7.2");
});

test("M2.2：placeholder 76% 混色约束——求解对象是共享派生后的有效前景，不是原始 token", () => {
  const roles = [
    {
      id: "input.placeholder",
      threshold: 4.5,
      foregroundTokens: ["textSecondary"],
      backgroundTokens: ["panelBackground"],
      effective: (tokens) => ({
        ratio: contrastRatio(compositeSrgb(tokens.textSecondary, 0.76, tokens.panelBackground), tokens.panelBackground),
      }),
    },
  ];
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  const finalRatio = contrastRatio(compositeSrgb(result.tokens.textSecondary, 0.76, LIGHT_PANEL), LIGHT_PANEL);
  assert.ok(finalRatio >= 4.5, `混色后达 4.5：${finalRatio.toFixed(3)}`);
  // 起点值（L 0.43）混色后实测 ~4.02 不达——求解必须移动过
  assert.ok(result.solvedTokens.textSecondary.finalL < LIGHT_FOREGROUNDS.textSecondary.startL, "自起点向更深移动");
});

test("M2.2：accent 联合约束——强调小字与白色填充文字共同钳制；minC 地板不被降破", () => {
  const roles = [
    contrastRole(
      "accent.small-text",
      4.5,
      (t) => t.accent,
      (t) => t.panelBackground,
      {
        fg: ["accent"],
        bg: ["panelBackground"],
      },
    ),
    contrastRole(
      "button.filled-text",
      4.5,
      () => "#FFFFFF",
      (t) => t.accent,
      {
        fg: [],
        bg: ["accent"],
      },
    ),
  ];
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  const accent = result.tokens.accent;
  assert.ok(contrastRatio(accent, LIGHT_PANEL) >= 4.5, "accent 对面板底 ≥ 4.5");
  assert.ok(contrastRatio("#FFFFFF", accent) >= 4.5, "白字对 accent 填充 ≥ 4.5");
  // 起点 L 0.55 不满足（实测联合可行带最高 ~0.549），必须向下移动
  assert.ok(result.solvedTokens.accent.finalL < LIGHT_FOREGROUNDS.accent.startL, "accent 自起点向下移动");
  assert.ok(result.solvedTokens.accent.finalC >= LIGHT_FOREGROUNDS.accent.minC - 1e-6, "实现 C 不低于 minC 地板");
});

test("M2.2：非单调双可行段——按离起点最近取段（不选比值更高的远段）；段内细化突破网格步长", () => {
  const inBand = (L) => (L >= 0.185 && L <= 0.2) || (L >= 0.42 && L <= 0.435);
  const roles = [
    {
      id: "synthetic.bands",
      threshold: 4.5,
      foregroundTokens: ["textPrimary"],
      backgroundTokens: [],
      effective: (tokens) => ({ ratio: inBand(decodedL(tokens.textPrimary)) ? 5 : 2 }),
    },
  ];
  const evaluate = syntheticEvaluate(roles);
  const base = {
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: evaluate,
    corrections: LIGHT_CORRECTIONS,
  };
  // (a) 起点 0.24：近段 A [0.185,0.20]（远段 B 比值同为 5——距离规则优先）
  const nearA = solveModeForegrounds({ ...base, foregrounds: LIGHT_FOREGROUNDS });
  assert.equal(nearA.status, SOLVE_STATUS.SOLVED);
  assert.ok(inBand(decodedL(nearA.tokens.textPrimary)), "落在近段 A");
  // (b) 起点 0.31：B 段 [0.42,0.435] 距离更近（0.1106 < 0.1120），须换段
  const shifted = { ...LIGHT_FOREGROUNDS, textPrimary: { ...LIGHT_FOREGROUNDS.textPrimary, startL: 0.31 } };
  const nearB = solveModeForegrounds({ ...base, foregrounds: shifted });
  assert.equal(nearB.status, SOLVE_STATUS.SOLVED);
  assert.ok(decodedL(nearB.tokens.textPrimary) >= 0.42, "落在近段 B");
  // (c) A 段右缘细化：网格最后可行点 L=0.19797，细化应找到更贴近段界 0.20 的可行点
  assert.ok(decodedL(nearA.tokens.textPrimary) > 0.1975, "选中点越过最后可行网格点（细化增益）");
  assert.ok(decodedL(nearA.tokens.textPrimary) <= 0.2000001, "不越过段界");
});

test("M2.2：选择优先级——|ΔL| 压倒 |ΔC|；|ΔL| 相同时取离目标 C 最近的层；真实比值角色同样受益于细化", () => {
  // (a) 全区间可行：|ΔL| 相同 → 取目标 C（maxC）层，而不是 0.5×maxC 层
  const flatRoles = [
    {
      id: "synthetic.flat",
      threshold: 4.5,
      foregroundTokens: ["textPrimary"],
      backgroundTokens: [],
      effective: () => ({ ratio: 5 }),
    },
  ];
  const flat = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(flatRoles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(flat.status, SOLVE_STATUS.SOLVED);
  assert.ok(flat.solvedTokens.textPrimary.finalC > 0.016, "无约束时 C 停在离目标最近的层");
  // (b) 近处只有低 C 层可行、远处高 C 层也可行：|ΔL| 优先，牺牲 C 偏好
  const farBandHighC = [
    {
      id: "synthetic.far-band",
      threshold: 4.5,
      foregroundTokens: ["textPrimary"],
      backgroundTokens: [],
      effective: (tokens) => {
        const lch = oklabToOklch(srgbToOklab(hexToSrgb(tokens.textPrimary)));
        const nearFeasible = lch.C < 0.012;
        const farFeasible = lch.C >= 0.012 && lch.L >= 0.42 && lch.L <= 0.435;
        return { ratio: nearFeasible || farFeasible ? 5 : 2 };
      },
    },
  ];
  const tradeoff = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(farBandHighC),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(tradeoff.status, SOLVE_STATUS.SOLVED);
  const chosenLch = oklabToOklch(srgbToOklab(hexToSrgb(tradeoff.tokens.textPrimary)));
  assert.ok(Math.abs(chosenLch.L - LIGHT_FOREGROUNDS.textPrimary.startL) <= 0.005, "取离起点最近的 L");
  assert.ok(chosenLch.C < 0.012, "为此牺牲 C 偏好（低 C 层）");
  // (c) 真实对比角色：T=15 交叉在网格 i=45/46 之间（0.2306/0.2336），细化须找到
  //     越过最后可行网格点、比值仍 ≥15 的点
  const contrast15 = [
    contrastRole(
      "panel.metric",
      4.5,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  const strict = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: { ...M22_POLICY, solver: { ...M22_POLICY.solver, primaryTextTarget: 15 } },
    evaluatePalette: syntheticEvaluate(contrast15),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(strict.status, SOLVE_STATUS.SOLVED);
  assert.ok(decodedL(strict.tokens.textPrimary) > 0.2306, "越过最后可行网格点（细化）");
  assert.ok(contrastRatio(strict.tokens.textPrimary, LIGHT_PANEL) >= 15, "细化点仍达 15");
});

test("M2.2：无可行采样点——UNSATISFIABLE、失败出口不带 tokens、逐组留档", () => {
  const roles = [
    contrastRole(
      "panel.impossible",
      30,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.UNSATISFIABLE);
  assert.ok(!("tokens" in result), "失败出口不输出半套颜色");
  assert.equal(result.attempts.length, LIGHT_CORRECTIONS.length);
  for (const attempt of result.attempts) {
    assert.equal(attempt.outcome, "unsat");
    assert.ok(attempt.diagnostics.length >= 1, "逐 token 诊断留档");
  }
});

test("M2.2：固定状态色最高可达对比仍不合格——CONTRACT_CONFLICT，且不搜索无关前景", () => {
  let calls = 0;
  const evaluate = (request) => {
    calls += 1;
    return syntheticEvaluate([
      contrastRole(
        "status.green-fixed",
        21,
        () => "#2f855a",
        (t) => t.panelBackground,
        {
          fg: [],
          bg: ["panelBackground"],
        },
      ),
    ])(request);
  };
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: evaluate,
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.CONTRACT_CONFLICT);
  assert.equal(calls, LIGHT_CORRECTIONS.length, "每组仅一次预检，无前景搜索");
  assert.ok(!("tokens" in result));
  for (const attempt of result.attempts) {
    assert.equal(attempt.outcome, "fixed-blocked");
    assert.equal(attempt.fixedRoles[0].roleId, "status.green-fixed");
    assert.ok(attempt.fixedRoles[0].ratio < 21, "记录最高可达比值");
  }
});

test("M2.2：预算耗尽——SEARCH_BUDGET_EXCEEDED、停止且不加轮数不降门槛", () => {
  const roles = [
    contrastRole(
      "panel.impossible",
      30,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  const tightBudget = { ...M22_POLICY, searchBudget: { ...M22_POLICY.searchBudget, maxTrialsPerTokenPerRound: 8 } };
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: tightBudget,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(result.status, SOLVE_STATUS.SEARCH_BUDGET_EXCEEDED);
  assert.ok(!("tokens" in result));
  for (const attempt of result.attempts) {
    assert.equal(attempt.outcome, "budget");
    assert.equal(attempt.round, 1, "预算耗尽即停，不进入后续轮");
    assert.equal(attempt.trialsByToken["textPrimary#r1"], 8, "试值数恰为预算上限");
    assert.equal(attempt.diagnostics[0].tau, M22_POLICY.solver.primaryTextTarget, "未降门槛继续");
    assert.ok(!("textSecondary#r1" in attempt.trialsByToken), "后续 token 未搜索");
  }
});

test("M2.2：预算耗尽但早期已有可行点——仍 SEARCH_BUDGET_EXCEEDED（不完整搜索不得宣布成功）；同配方足额预算可解", () => {
  const roles = [
    contrastRole(
      "panel.metric",
      4.5,
      (t) => t.textPrimary,
      (t) => t.panelBackground,
      {
        fg: ["textPrimary"],
        bg: ["panelBackground"],
      },
    ),
  ];
  const evaluate = syntheticEvaluate(roles);
  // 浅色网格自 lMin（深端）起评：首点即对浅面板达标（≥7.2）——预算 5 时第 1 层前几个
  // 网格点已产出可行点，但 129 点网格与边界细化远未完成
  const truncated = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: { ...M22_POLICY, searchBudget: { ...M22_POLICY.searchBudget, maxTrialsPerTokenPerRound: 5 } },
    evaluatePalette: evaluate,
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(truncated.status, SOLVE_STATUS.SEARCH_BUDGET_EXCEEDED);
  assert.ok(!("tokens" in truncated), "失败出口不输出半套颜色");
  assert.equal(truncated.attempts[0].outcome, "budget");
  assert.equal(truncated.attempts[0].trialsByToken["textPrimary#r1"], 5, "试值数恰为预算上限");
  assert.equal(truncated.attempts[0].diagnostics[0].status, "budget");
  // 对照：同一配方、足额预算正常解出——证明可行点确实存在，失败只因预算截断
  const ample = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: evaluate,
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  });
  assert.equal(ample.status, SOLVE_STATUS.SOLVED);
  assert.ok(contrastRatio(ample.tokens.textPrimary, LIGHT_PANEL) >= 7.2, "足额预算下达 7.2 优选");
});

test("M2.2：共享派生后关联角色退化——轮末重查捕获、第 2 轮由先解 token 修复", () => {
  // 场景（全诚实依赖申报）：联合角色 ts-over-accent ≥1.4（contrastRatio 取 max/min，
  // 文字与 accent 拉开足够亮度差即可）在 ts=0.78 时要求 accent ∈ 深带[~0.40,0.63] ∪
  // 浅带[≥0.88]；accent 自身角色 accent-panel ≥7 只允许 [~0.725, lMax=0.80]——浅带被
  // lMax 掐断、深带与自身冲突 → accent 第 1 轮无解（交叉约束 → 保留现值）；轮末重查
  // 捕获 ts.over.accent 失败 → 第 2 轮 textSecondary 移到与 accent 拉开 1.4 的位置。
  const roles = [
    contrastRole(
      "ts.panel",
      4.5,
      (t) => t.textSecondary,
      (t) => t.panelBackground,
      {
        fg: ["textSecondary"],
        bg: ["panelBackground"],
      },
    ),
    contrastRole(
      "accent.panel",
      7,
      (t) => t.accent,
      (t) => t.panelBackground,
      {
        fg: ["accent"],
        bg: ["panelBackground"],
      },
    ),
    contrastRole(
      "ts.over.accent",
      1.4,
      (t) => t.textSecondary,
      (t) => t.accent,
      {
        fg: ["textSecondary"],
        bg: ["accent"],
      },
    ),
  ];
  const darkAccentSpec = { ...DARK_FOREGROUNDS.accent, lMin: 0.4, lMax: 0.8 };
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "dark",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: DARK_CORRECTIONS,
    foregrounds: { ...DARK_FOREGROUNDS, accent: darkAccentSpec },
  });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  assert.equal(result.roundsUsed, 2, `第 2 轮修复耦合：实际 ${result.roundsUsed}`);
  assert.ok(contrastRatio(result.tokens.textSecondary, result.tokens.accent) >= 1.4, "联合角色在第 2 轮达成");
  assert.ok(contrastRatio(result.tokens.accent, DARK_PANEL) >= 7, "accent 保持自身高位约束");
  assert.ok(
    Math.abs(result.solvedTokens.textSecondary.finalL - DARK_FOREGROUNDS.textSecondary.startL) > 0.01,
    "textSecondary 移离起点以达成联合角色",
  );
});

test("M2.2：交叉耦合角色——accent 自行移入联合带（第 1 轮解决）；互相钳死时诚实 4 轮后 UNSATISFIABLE", () => {
  const darkAccentSpec = { ...DARK_FOREGROUNDS.accent, lMin: 0.4 };
  const darkForegrounds = { ...DARK_FOREGROUNDS, accent: darkAccentSpec };
  const build = (accentThreshold, jointThreshold) => {
    const roles = [
      contrastRole(
        "ts.panel",
        4.5,
        (t) => t.textSecondary,
        (t) => t.panelBackground,
        {
          fg: ["textSecondary"],
          bg: ["panelBackground"],
        },
      ),
      contrastRole(
        "accent.panel",
        accentThreshold,
        (t) => t.accent,
        (t) => t.panelBackground,
        {
          fg: ["accent"],
          bg: ["panelBackground"],
        },
      ),
      contrastRole(
        "ts.over.accent",
        jointThreshold,
        (t) => t.textSecondary,
        (t) => t.accent,
        {
          fg: ["textSecondary"],
          bg: ["accent"],
        },
      ),
    ];
    return solveModeForegrounds({
      ...SOLVE_OPTIONS,
      mode: "dark",
      policy: M22_POLICY,
      evaluatePalette: syntheticEvaluate(roles),
      corrections: DARK_CORRECTIONS,
      foregrounds: darkForegrounds,
    });
  };
  // 有解：accent-panel ≥3 ∧ ts-over-accent ≥1.8 在 accent 轴有公共可行带 → 第 1 轮解决
  const resolved = build(3, 1.8);
  assert.equal(resolved.status, SOLVE_STATUS.SOLVED);
  assert.ok(contrastRatio(resolved.tokens.accent, DARK_PANEL) >= 3, "accent 自身角色达成");
  assert.ok(contrastRatio(resolved.tokens.textSecondary, resolved.tokens.accent) >= 1.8, "联合角色达成");
  assert.ok(
    resolved.solvedTokens.accent.finalL < DARK_FOREGROUNDS.accent.startL + 1e-9 ||
      resolved.solvedTokens.accent.finalL > DARK_FOREGROUNDS.accent.startL - 1e-9,
    "accent 取值已定",
  );
  // 死锁：accent-panel ≥7（L≥~0.725）∧ ts-over-accent ≥2.2（深带 L≤~0.50，浅带需
  // 亮度差超过物理上限）→ 公共带为空且无法互相修复 → 4 轮后诚实失败
  const deadlock = build(7, 2.2);
  assert.equal(deadlock.status, SOLVE_STATUS.UNSATISFIABLE);
  assert.ok(!("tokens" in deadlock));
  assert.equal(deadlock.attempts[0].roundsUsed, 4, "轮次机制完整跑满");
  assert.ok(
    deadlock.attempts[0].failingRoles.some((role) => role.roleId === "ts.over.accent"),
    "失败角色留档",
  );
});

test("M2.2：非法输入与评估器契约违背显式报错；solver 模块纯度", () => {
  const roles = [];
  const options = {
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  };
  assert.throws(() => solveModeForegrounds({ ...options, evaluatePalette: "nope" }), /evaluatePalette/);
  assert.throws(() => solveModeForegrounds({ ...options, mode: "noon" }), /mode/);
  assert.throws(() => solveModeForegrounds({ ...options, policy: { ...M22_POLICY, solver: null } }), /policy\.solver/);
  assert.throws(
    () =>
      solveModeForegrounds({
        ...options,
        policy: { ...M22_POLICY, searchBudget: { ...M22_POLICY.searchBudget, maxTrialsPerTokenPerRound: 0 } },
      }),
    /maxTrialsPerTokenPerRound/,
  );
  assert.throws(() => solveModeForegrounds({ ...options, corrections: [] }), /corrections/);
  assert.throws(
    () =>
      solveModeForegrounds({
        ...options,
        corrections: [
          { ...LIGHT_CORRECTIONS[0], backgrounds: { ...LIGHT_CORRECTIONS[0].backgrounds, panelBackground: "#edf2fe" } },
        ],
      }),
    /panelBackground/,
  );
  assert.throws(
    () => solveModeForegrounds({ ...options, foregrounds: { ...LIGHT_FOREGROUNDS, accent: {} } }),
    /accent/,
  );
  assert.throws(() => solveModeForegrounds({ ...options, evaluatePalette: () => ({}) }), /entries/);
  assert.throws(
    () =>
      solveModeForegrounds({ ...options, evaluatePalette: () => ({ entries: [{ roleId: "x", status: "unknown" }] }) }),
    /契约/,
  );
  const source = readFileSync(new URL("../scripts/skin-palette/solver.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s+[^;]+?from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./color-math.mjs"]);
  for (const banned of ["readFile", "writeFile", "document", "window", "Math.random", "Date.now", "process."]) {
    assert.ok(!source.includes(banned), `求解器模块不得出现 ${banned}`);
  }
});

test("M2.2：评估器契约从严——缺依赖数组即违约（缺省为空会让 τ 约束静默失效）、缺字段/非法键/未测带比值显式报错", () => {
  const base = {
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    corrections: LIGHT_CORRECTIONS,
    foregrounds: LIGHT_FOREGROUNDS,
  };
  const goodRole = {
    roleId: "panel.metric",
    required: true,
    status: "pass",
    ratio: 8,
    threshold: 4.5,
    foregroundTokens: ["textPrimary"],
    backgroundTokens: ["panelBackground"],
  };
  const without = (field) => {
    const entry = { ...goodRole };
    delete entry[field];
    return [entry];
  };
  const expectContractError = (label, entries) => {
    assert.throws(() => solveModeForegrounds({ ...base, evaluatePalette: () => ({ entries }) }), /契约/, label);
  };
  // 用户复核场景：ratio 4.6 达角色阈值（4.5）但低于搜索目标（7.2）——依赖数组若被
  // 缺省为空，该 τ 约束会从搜索与轮末重查中静默消失
  expectContractError("缺 foregroundTokens", without("foregroundTokens"));
  expectContractError("缺 backgroundTokens", without("backgroundTokens"));
  expectContractError("required 缺失", without("required"));
  expectContractError("pass 无 ratio", [{ ...goodRole, ratio: null }]);
  expectContractError("fail 无 threshold", [{ ...goodRole, status: "fail", threshold: null }]);
  expectContractError("ratio NaN", [{ ...goodRole, ratio: Number.NaN }]);
  expectContractError("threshold 为负", [{ ...goodRole, threshold: -1 }]);
  expectContractError("roleId 空串", [{ ...goodRole, roleId: "" }]);
  expectContractError("依赖键不在 12 token 键集", [{ ...goodRole, foregroundTokens: ["ink"] }]);
  expectContractError("依赖元素非字符串", [{ ...goodRole, backgroundTokens: [7] }]);
  expectContractError("unmeasured 带比值", [{ ...goodRole, status: "unmeasured", ratio: 3.1, threshold: null }]);
  expectContractError("unmeasured 缺 threshold（undefined 视为缺失，非显式 null）", [
    { ...goodRole, status: "unmeasured", ratio: null, threshold: undefined },
  ]);
  // 契约内的未测角色（ratio 为空）不报错：求解照常推进并记录
  const withUnmeasured = {
    entries: [
      { ...goodRole },
      {
        roleId: "chart.legend",
        required: true,
        status: "unmeasured",
        ratio: null,
        threshold: 3,
        foregroundTokens: ["chartText"],
        backgroundTokens: ["panelBackground"],
      },
    ],
  };
  const result = solveModeForegrounds({ ...base, evaluatePalette: () => withUnmeasured });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  assert.deepEqual(result.unmeasuredRoles, ["chart.legend"]);
});

test("M2.2：镜像归源——controlText/controlBorder 依赖键归源后参与匹配，τ 约束不因控制键声明而失效", () => {
  const roles = [
    {
      id: "control.label",
      threshold: 4.5,
      foregroundTokens: ["controlText"],
      backgroundTokens: ["panelBackground"],
      effective: (tokens) => ({ ratio: contrastRatio(tokens.controlText, tokens.panelBackground) }),
    },
    {
      id: "control.border",
      threshold: 3,
      foregroundTokens: [],
      backgroundTokens: ["controlBorder"],
      effective: () => ({ ratio: 5 }),
    },
  ];
  // textPrimary 钳到 [0.44,0.48]：对浅面板最高 ~6.98 < 7.2——controlText 依赖正确
  // 归源绑定到 textPrimary 搜索时必须降 4.7 并记录 preferredContrastUnmet；若被
  // 静默丢弃则无相关角色、任意点可行，起点即"达标"且无回退记录
  const constrained = {
    ...LIGHT_FOREGROUNDS,
    textPrimary: { ...LIGHT_FOREGROUNDS.textPrimary, startL: 0.46, lMin: 0.44, lMax: 0.48 },
  };
  const result = solveModeForegrounds({
    ...SOLVE_OPTIONS,
    mode: "light",
    policy: M22_POLICY,
    evaluatePalette: syntheticEvaluate(roles),
    corrections: LIGHT_CORRECTIONS,
    foregrounds: constrained,
  });
  assert.equal(result.status, SOLVE_STATUS.SOLVED);
  assert.equal(result.preferredContrastUnmet, true, "controlText 依赖已绑定 textPrimary 搜索（7.2 不可达 → 回退）");
  const ratio = contrastRatio(result.tokens.textPrimary, LIGHT_PANEL);
  assert.ok(ratio >= 4.7 && ratio < 7.2, `回退带内：${ratio.toFixed(3)}`);
  assert.equal(result.tokens.controlText, result.tokens.textPrimary, "镜像输出不变");
});

// ---------------------------------------------------------------------------
// M2.3 浅深配对、去重与可复现候选（generate.mjs）
// ---------------------------------------------------------------------------

const M23_POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
const makeM23Profile = (overrides = {}) => ({
  identityHex: "#4F4971",
  surfaceH: 268,
  surfaceC: 0.028,
  pageL: { light: 0.93, dark: 0.17 },
  accentC: 0.1,
  ...overrides,
});
const M23_PROFILES = { chatgpt: makeM23Profile(), grok: makeM23Profile() };

/** 真实角色 ID + 自定义依赖（FailureRecord 的 roleIds 必须能通过 M0 契约校验）。 */
const m23Role = (id, threshold, fgOf, bgOf, deps) => ({
  id,
  threshold,
  effective: (tokens) => ({ ratio: contrastRatio(fgOf(tokens), bgOf(tokens)) }),
  foregroundTokens: deps.fg ?? [],
  backgroundTokens: deps.bg ?? [],
});
const M23_BASELINE_ROLES = [
  m23Role(
    "page.body-text",
    4.5,
    (t) => t.textPrimary,
    (t) => t.pageBackground,
    {
      fg: ["textPrimary"],
      bg: ["pageBackground"],
    },
  ),
  m23Role(
    "panel.metric-value",
    4.5,
    (t) => t.textPrimary,
    (t) => t.panelBackground,
    {
      fg: ["textPrimary"],
      bg: ["panelBackground"],
    },
  ),
  m23Role(
    "panel.metric-label",
    4.5,
    (t) => t.textSecondary,
    (t) => t.panelBackground,
    {
      fg: ["textSecondary"],
      bg: ["panelBackground"],
    },
  ),
  m23Role(
    "toast.quota-status",
    3,
    (t) => t.accent,
    (t) => t.panelBackground,
    {
      fg: ["accent"],
      bg: ["panelBackground"],
    },
  ),
];
const m23Evaluate =
  (roles) =>
  ({ tokens, mode, skinId }) => ({
    entries: roles.map((role) => {
      const measured = role.effective(tokens, mode, skinId);
      const status = measured.status ?? (measured.ratio >= role.threshold ? "pass" : "fail");
      return {
        roleId: role.id,
        required: role.required !== false,
        status,
        ratio: measured.ratio ?? null,
        threshold: role.threshold ?? null,
        foregroundTokens: role.foregroundTokens ?? [],
        backgroundTokens: role.backgroundTokens ?? [],
      };
    }),
  });
// §4.1 派生源摘要由调用方计算后显式传入（模拟 M2.4 CLI 的路径）——generate 本体零文件读取
const M23_DERIVATION_HASH = createHash("sha256")
  .update(readFileSync(new URL("../public/skins.js", import.meta.url)))
  .digest("hex");
const m23Run = ({
  skinIds,
  profiles = M23_PROFILES,
  roles = M23_BASELINE_ROLES,
  policy = M23_POLICY,
  derivationHash = M23_DERIVATION_HASH,
}) =>
  generateCandidates({
    profiles,
    skinIds,
    seed: "palette-redesign-v1",
    policy,
    roleCatalog: { synthetic: true },
    evaluatePalette: m23Evaluate(roles),
    derivationHash,
  });

const M23_SIX_SAMPLES = Object.freeze([
  { mode: "light", token: "pageBackground" },
  { mode: "light", token: "panelBackground" },
  { mode: "light", token: "accent" },
  { mode: "dark", token: "pageBackground" },
  { mode: "dark", token: "panelBackground" },
  { mode: "dark", token: "accent" },
]);

test("M2.3：生成结构契约自洽——候选/失败记录过 M0 校验、顺序注册×a/b/c、深冻结、跨皮肤同配方不互相去重", () => {
  const result = m23Run({ skinIds: ["chatgpt", "grok"] });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    const verdict = validateCandidate(candidate);
    assert.ok(verdict.valid, `${candidate.id}: ${JSON.stringify(verdict.errors.slice(0, 3))}`);
  }
  for (const record of result.rejected) {
    const verdict = validateFailureRecord(record);
    assert.ok(verdict.valid, `${record.code}: ${JSON.stringify(verdict.errors.slice(0, 3))}`);
  }
  assert.equal(result.inputHashes.roles, hashRoleInputs(), "角色清单摘要与 M0 一致");
  assert.equal(result.candidateSetHash, hashCandidateSet(result), "候选集摘要自洽");
  const setVerdict = validateCandidateSet(result, { expectedSkinIds: [] });
  assert.ok(setVerdict.valid, JSON.stringify(setVerdict.errors.slice(0, 3)));
  // 顺序：注册表顺序 × a/b/c，严格递增
  const rankOf = new Map(SKIN_IDS.map((id, index) => [id, index]));
  let previousRank = -1;
  for (const candidate of result.candidates) {
    const rank = rankOf.get(candidate.skinId) * VARIANTS.length + VARIANTS.indexOf(candidate.variant);
    assert.ok(rank > previousRank, `候选顺序 ${candidate.id}`);
    previousRank = rank;
  }
  // 深冻结
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.candidates));
  assert.ok(Object.isFrozen(result.candidates[0]));
  assert.ok(Object.isFrozen(result.candidates[0].modes.light));
  // 去重后每皮肤 a/b 幸存（c 与 a 近重复），跨皮肤同配方互不删减且 token 相同
  for (const skinId of ["chatgpt", "grok"]) {
    assert.deepEqual(
      result.candidates.filter((c) => c.skinId === skinId).map((c) => c.variant),
      ["a", "b"],
      `${skinId} 幸存变体`,
    );
    const duplicate = result.rejected.find((r) => r.skinId === skinId && r.code === "DUPLICATE_CANDIDATE");
    assert.ok(duplicate, `${skinId} 去重记录存在`);
  }
  const chatgptA = result.candidates.find((c) => c.skinId === "chatgpt" && c.variant === "a");
  const grokA = result.candidates.find((c) => c.skinId === "grok" && c.variant === "a");
  assert.deepEqual(chatgptA.modes, grokA.modes, "同配方跨皮肤 token 相同但各自保留");
  assert.notEqual(chatgptA.id, grokA.id, "id 以 skinId 区分");
  assert.ok(Number.isFinite(chatgptA.parameters.search.readingMargin), "阅读余量已记录");
  assert.equal(chatgptA.style.identitySource, "#4F4971", "style 说明锚定代表色");
  // 输入不可变：deepFreeze 只冻结快照拷贝，调用方配方（含嵌套字段）保持可变
  const mutableProfile = makeM23Profile();
  const isolated = m23Run({ skinIds: ["chatgpt"], profiles: { chatgpt: mutableProfile } });
  assert.equal(Object.isFrozen(mutableProfile), false, "调用方配方未被冻结");
  assert.equal(Object.isFrozen(mutableProfile.pageL), false, "调用方配方嵌套字段未被冻结");
  mutableProfile.accentC = 0.11; // 原配方仍可继续修改（纯函数约定）
  const snapshotOf = isolated.candidates[0].profileSnapshot;
  assert.deepEqual(snapshotOf, makeM23Profile(), "profileSnapshot 是配方的保真快照");
  assert.ok(Object.isFrozen(snapshotOf), "快照本体深冻结");
});

test("M2.3：同输入两次结果逐字相同；仅选一个 skin 不改变该 skin 的候选与失败记录", () => {
  const first = m23Run({ skinIds: ["chatgpt", "grok"] });
  const second = m23Run({ skinIds: ["chatgpt", "grok"] });
  assert.equal(canonicalJson(first), canonicalJson(second), "重复生成逐字相同");
  const solo = m23Run({ skinIds: ["grok"] });
  const grokCandidates = first.candidates.filter((candidate) => candidate.skinId === "grok");
  const grokRejected = first.rejected.filter((record) => record.skinId === "grok");
  assert.equal(canonicalJson(solo.candidates), canonicalJson(grokCandidates), "单选 skin 候选不变");
  assert.equal(canonicalJson(solo.rejected), canonicalJson(grokRejected), "单选 skin 失败记录不变");
  assert.deepEqual(
    solo.candidates.map((candidate) => candidate.id),
    grokCandidates.map((candidate) => candidate.id),
    "候选 id 逐字一致",
  );
  assert.equal(
    solo.inputHashes.profiles,
    sha256Canonical({ grok: M23_PROFILES.grok }),
    "profiles 摘要覆盖本run消费的配方",
  );
});

test("M2.3：浅深失败不出现孤立模式——单模式无解该变体整体出局；两模式全败逐模式留档", () => {
  const lightFail = [
    {
      id: "status.home-reason",
      threshold: 4.5,
      // 仅 chatgpt 浅色失败：失败是皮肤×模式条件的，另一皮肤照常产出候选
      effective: (_tokens, mode, skinId) => (skinId === "chatgpt" && mode === "light" ? { ratio: 2 } : { ratio: 8 }),
      foregroundTokens: ["textPrimary"],
      backgroundTokens: ["pageBackground"],
    },
  ];
  const lightOnly = m23Run({ skinIds: ["chatgpt", "grok"], roles: [...M23_BASELINE_ROLES, ...lightFail] });
  const chatgptRecords = lightOnly.rejected.filter((record) => record.skinId === "chatgpt");
  assert.equal(lightOnly.candidates.filter((candidate) => candidate.skinId === "chatgpt").length, 0, "chatgpt 无候选");
  assert.deepEqual(
    chatgptRecords.map((record) => [record.code, record.mode, record.variant]),
    [
      ["UNSATISFIABLE", "light", "a"],
      ["UNSATISFIABLE", "light", "b"],
      ["UNSATISFIABLE", "light", "c"],
    ],
    "逐变体一条 light 无解记录，dark 已解也不产出孤立模式",
  );
  assert.ok(
    lightOnly.candidates.some((candidate) => candidate.skinId === "grok"),
    "另一皮肤照常产出",
  );
  // 失败角色与比值证据：首轮换组从未走到轮末重查，也要留档受限角色及其最高可达比值
  for (const record of chatgptRecords) {
    assert.deepEqual(record.roleIds, ["status.home-reason"], "无解记录列出受限角色");
    assert.equal(record.worstRatio, 2, "受限角色搜索集内最高可达比值");
    assert.equal(record.threshold, 4.5, "受限角色阈值留档");
    assert.ok(record.message.length >= 8);
  }
  const alwaysFail = [
    {
      id: "status.home-reason",
      threshold: 4.5,
      effective: () => ({ ratio: 2 }),
      foregroundTokens: ["textPrimary"],
      backgroundTokens: ["pageBackground"],
    },
  ];
  const bothFail = m23Run({ skinIds: ["chatgpt"], roles: [...M23_BASELINE_ROLES, ...alwaysFail] });
  assert.equal(bothFail.candidates.length, 0, "全冲突输出允许空候选（明确冲突，不用默认 palette 兜底）");
  assert.deepEqual(
    bothFail.rejected.map((record) => [record.code, record.mode, record.variant]),
    [
      ["UNSATISFIABLE", "light", "a"],
      ["UNSATISFIABLE", "dark", "a"],
      ["UNSATISFIABLE", "light", "b"],
      ["UNSATISFIABLE", "dark", "b"],
      ["UNSATISFIABLE", "light", "c"],
      ["UNSATISFIABLE", "dark", "c"],
    ],
    "两模式全败逐模式留档",
  );
  assert.ok(
    bothFail.rejected.every((record) => record.message.length >= 8),
    "失败记录 message 说明",
  );
  for (const record of bothFail.rejected) {
    assert.deepEqual(record.roleIds, ["status.home-reason"], "始终失败角色进 roleIds（原为空）");
    assert.equal(record.worstRatio, 2, "始终失败角色比值 2（原为 null）");
    assert.equal(record.threshold, 4.5);
  }
});

test("M2.3：固定色冲突与预算耗尽的失败映射——留档角色、最高可达比值与已尝试范围", () => {
  const fixedRole = [
    m23Role(
      "status.autorefresh-error",
      21,
      () => "#2f855a",
      (t) => t.panelBackground,
      {
        fg: [],
        bg: ["panelBackground"],
      },
    ),
  ];
  const conflict = m23Run({ skinIds: ["chatgpt"], roles: [...M23_BASELINE_ROLES, ...fixedRole] });
  assert.equal(conflict.candidates.length, 0);
  assert.equal(conflict.rejected.length, 6);
  for (const record of conflict.rejected) {
    assert.equal(record.code, "CONTRACT_CONFLICT");
    assert.deepEqual(record.roleIds, ["status.autorefresh-error"]);
    assert.ok(Number.isFinite(record.worstRatio) && record.worstRatio < 21, `留最高可达比值 ${record.worstRatio}`);
    assert.equal(record.threshold, 21);
    assert.equal(record.attemptedRanges.length, 3, "三个修正组都留档");
    assert.ok(record.attemptedRanges.every((range) => range.outcome === "fixed-blocked"));
  }
  const tightPolicy = {
    ...M23_POLICY,
    searchBudget: { ...M23_POLICY.searchBudget, maxTrialsPerTokenPerRound: 5 },
  };
  const budget = m23Run({ skinIds: ["chatgpt"], policy: tightPolicy });
  assert.equal(budget.candidates.length, 0);
  assert.equal(budget.rejected.length, 6);
  for (const record of budget.rejected) {
    assert.equal(record.code, "SEARCH_BUDGET_EXCEEDED");
    assert.equal(record.worstRatio, null);
    assert.equal(record.roleIds.length, 0);
    assert.equal(record.attemptedRanges[0].outcome, "budget");
    assert.equal(record.attemptedRanges[0].round, 1, "第 1 轮耗尽即停");
    assert.ok(record.message.length >= 8);
  }
});

test("M2.3：预算耗尽记录附耗尽前已观测证据——失败角色与比值留档（总计划 §5）", () => {
  const alwaysFail = [
    {
      id: "status.home-reason",
      threshold: 4.5,
      effective: () => ({ ratio: 2 }),
      foregroundTokens: ["textPrimary"],
      backgroundTokens: ["pageBackground"],
    },
  ];
  // 预算 3：textPrimary 仅评 3 个网格点即耗尽——耗尽前始终失败角色已被观测
  const tight = { ...M23_POLICY, searchBudget: { ...M23_POLICY.searchBudget, maxTrialsPerTokenPerRound: 3 } };
  const result = m23Run({ skinIds: ["chatgpt"], roles: [...M23_BASELINE_ROLES, ...alwaysFail], policy: tight });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected.length, 6, "三变体 × 浅深逐模式留档");
  for (const record of result.rejected) {
    assert.equal(record.code, "SEARCH_BUDGET_EXCEEDED");
    assert.deepEqual(record.roleIds, ["status.home-reason"], "耗尽前已观测的失败角色留档（原为空）");
    assert.equal(record.worstRatio, 2, "耗尽前已观测最高比值 2（原为 null）");
    assert.equal(record.threshold, 4.5);
    assert.equal(record.attemptedRanges.length, 1, "耗尽即整组循环停止，后续组未尝试");
    assert.equal(record.attemptedRanges[0].outcome, "budget");
    assert.ok(record.message.includes("已观测"), "消息限定：部分观测，不作最高可达论断");
    assert.ok(record.message.includes("不得宣布成功"));
  }
});

test("M2.3：预算耗尽即整组循环停止——不以新预算尝试后续组，已完成组证据并入记录", () => {
  const template = buildSurfaceTemplates(M23_PROFILES.chatgpt);
  const g0Page = template.variants.a.modes.light.corrections[0].backgrounds.pageBackground;
  const conditionalFail = [
    {
      id: "status.home-reason",
      threshold: 4.5,
      // 仅变体 a 浅色修正组 #0 的页背景下失败（比值 2）：该组 textPrimary 完整搜索
      // 无解 → 第 1 轮换组；后续组背景不同、角色达标 → 搜索推进后预算耗尽
      effective: (tokens) => (tokens.pageBackground === g0Page ? { ratio: 2 } : { ratio: 8 }),
      foregroundTokens: ["textPrimary"],
      backgroundTokens: ["pageBackground"],
    },
  ];
  // 预算 730：组 0 的无解网格（HEX 缓存去重后 ~705 次评估）可完整评完并换组；
  // 组 1 角色达标、搜索推进到 textSecondary（需 ~760 次）时耗尽——组 2 不再尝试
  const tight = { ...M23_POLICY, searchBudget: { ...M23_POLICY.searchBudget, maxTrialsPerTokenPerRound: 730 } };
  const result = m23Run({ skinIds: ["chatgpt"], roles: [...M23_BASELINE_ROLES, ...conditionalFail], policy: tight });
  const record = result.rejected.find(
    (entry) => entry.code === "SEARCH_BUDGET_EXCEEDED" && entry.variant === "a" && entry.mode === "light",
  );
  assert.ok(record, "变体 a 浅色预算耗尽记录存在");
  assert.deepEqual(
    record.attemptedRanges.map((range) => [range.groupIndex, range.outcome]),
    [
      [0, "unsat"],
      [1, "budget"],
    ],
    "组 0 无解换组、组 1 预算耗尽即停，组 2 不再尝试",
  );
  assert.deepEqual(record.roleIds, ["status.home-reason"], "已完成组的无解证据并入预算记录");
  assert.equal(record.worstRatio, 2);
  assert.equal(record.threshold, 4.5);
  assert.ok(record.message.includes("未完成"), "消息明示搜索未完成");
});

test("M2.3：近重复去重——六样本 D_OK 全 <2.0、记录含关联 ID 与可复算距离、保留余量更高者", () => {
  const result = m23Run({ skinIds: ["chatgpt"] });
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.variant),
    ["a", "b"],
    "c 与 a 近重复被去除",
  );
  const record = result.rejected.find((entry) => entry.code === "DUPLICATE_CANDIDATE");
  assert.ok(record, "去重记录存在");
  assert.equal(record.variant, "c");
  assert.equal(record.pair, "light+dark");
  const kept = result.candidates.find((candidate) => candidate.id === record.relatedCandidateId);
  assert.ok(kept, "关联候选存在且幸存");
  assert.equal(kept.variant, "a");
  assert.equal(record.distances.length, 6);
  assert.ok(
    record.distances.every((distance) => Number.isFinite(distance) && distance < 2.0),
    "六项距离全部 < 2.0",
  );
  // 距离可复算：用公开模块原样重建被去重变体 c，逐项对上记录里的 D_OK
  const template = buildSurfaceTemplates(M23_PROFILES.chatgpt);
  const rebuilt = {};
  for (const mode of ["light", "dark"]) {
    rebuilt[mode] = solveModeForegrounds({
      skinId: "chatgpt",
      mode,
      roleCatalog: { synthetic: true },
      policy: M23_POLICY,
      evaluatePalette: m23Evaluate(M23_BASELINE_ROLES),
      corrections: template.variants.c.modes[mode].corrections,
      foregrounds: template.variants.c.modes[mode].foregrounds,
    }).tokens;
  }
  M23_SIX_SAMPLES.forEach(({ mode, token }, index) => {
    const distance = okDistance(
      srgbToOklab(hexToSrgb(rebuilt[mode][token])),
      srgbToOklab(hexToSrgb(kept.modes[mode][token])),
    );
    closeTo(distance, record.distances[index], 1e-9, `六样本距离[${index}]`);
  });
  assert.ok(record.message.includes("阅读余量"), "去重理由可追溯");
});

test("M2.3：模块纯度——只依赖 M0/M1/M2 相对模块、零文件读取，derivationHash 为显式入参", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/generate.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s+[^;]+?from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...imports].sort(), ["./color-math.mjs", "./contracts.mjs", "./solver.mjs", "./templates.mjs"]);
  for (const banned of ["document", "window", "Math.random", "Date.now", "process.", "readFileSync"]) {
    assert.ok(!source.includes(banned), `generate 模块不得出现 ${banned}`);
  }
  // §4.1 语义由调用方保持（测试模拟 M2.4 CLI：collectSourceHashes 同款路径算摘要再传入）
  const skinsHash = createHash("sha256")
    .update(readFileSync(new URL("../public/skins.js", import.meta.url)))
    .digest("hex");
  assert.equal(M23_DERIVATION_HASH, skinsHash, "测试传入的派生源摘要 = public/skins.js 内容摘要");
  const result = m23Run({ skinIds: ["chatgpt"] });
  assert.equal(result.inputHashes.derivation, skinsHash, "derivationHash 入参进入候选集摘要（总计划 §4.1）");
  assert.equal(result.candidates[0].derivationHash, skinsHash, "候选上的派生源摘要一致");
  // 非法入参显式拒绝：缺失（不经默认值路径）与格式错误
  assert.throws(
    () =>
      generateCandidates({
        profiles: M23_PROFILES,
        skinIds: ["chatgpt"],
        seed: "palette-redesign-v1",
        policy: M23_POLICY,
        roleCatalog: { synthetic: true },
        evaluatePalette: m23Evaluate(M23_BASELINE_ROLES),
      }),
    /derivationHash/,
    "缺失 derivationHash 显式报错",
  );
  assert.throws(() => m23Run({ skinIds: ["chatgpt"], derivationHash: "zz-short" }), /derivationHash/, "格式非法报错");
});

// ---------------------------------------------------------------------------
// M2.4 生成 CLI 与产物写入（generate-cli.mjs）
// ---------------------------------------------------------------------------

const M24_CLI_PATH = fileURLToPath(new URL("../scripts/skin-palette/generate-cli.mjs", import.meta.url));
const M24_FIXED_NOW = "2026-10-04T00:00:00.000Z";
const m24Evaluate = m23Evaluate(M23_BASELINE_ROLES);

async function m24Workspace({ skins = ["chatgpt", "grok"] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "m24-generate-"));
  const validationRoot = path.join(root, "docs", "validation");
  const workstream = path.join(validationRoot, "2026-10-03-skin-palette-redesign");
  await mkdir(workstream, { recursive: true });
  const profilesPath = path.join(root, "profiles.json");
  await writeFile(
    profilesPath,
    JSON.stringify(Object.fromEntries(skins.map((skinId) => [skinId, makeM23Profile()]))),
    "utf8",
  );
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify(M23_POLICY), "utf8");
  return { root, validationRoot, workstream, profilesPath, policyPath };
}

/** 让指定皮肤在任何 token 组合下都不达标（其余皮肤恒 10，全部达标）。 */
const m24SkinGatedRoles = (failingSkinId) =>
  M23_BASELINE_ROLES.map((role) => ({
    ...role,
    effective: (tokens, mode, skinId) => ({ ratio: skinId === failingSkinId ? 2 : 10 }),
  }));

test("M2.4：参数解析——固定参数与 all 展开正确，未知/重复/缺值/未知皮肤显式报错", () => {
  const parsed = parseGenerateArgs([
    "--skins",
    "chatgpt,grok",
    "--seed",
    "palette-redesign-v1",
    "--out",
    "docs/validation/2026-10-03-skin-palette-redesign/pilot-r1",
  ]);
  assert.deepEqual(parsed.skins, ["chatgpt", "grok"]);
  assert.equal(parsed.seed, "palette-redesign-v1");
  assert.equal(parsed.profilesPath, undefined);
  assert.equal(parsed.policyPath, undefined);
  const all = parseGenerateArgs(["--skins=all", "--seed", "s", "--out", "o"]);
  assert.deepEqual(all.skins, [...SKIN_IDS], "--skins all 展开为注册表十套（排除 classic）");
  const overridden = parseGenerateArgs([
    "--skins",
    "chatgpt",
    "--seed",
    "s",
    "--out",
    "o",
    "--profiles",
    "p.json",
    "--policy",
    "q.json",
  ]);
  assert.equal(overridden.profilesPath, "p.json");
  assert.equal(overridden.policyPath, "q.json");
  assert.throws(
    () => parseGenerateArgs(["--skins", "chatgpt", "--seed", "s", "--out", "o", "--extra", "x"]),
    /未知参数/,
  );
  assert.throws(
    () => parseGenerateArgs(["--skins", "chatgpt", "--skins", "grok", "--seed", "s", "--out", "o"]),
    /重复给出/,
  );
  assert.throws(
    () => parseGenerateArgs(["--skins", "chatgpt", "--seed", "--out", "o"]),
    /需要一个值/,
    "把下一个面名当值的写法显式报错",
  );
  assert.throws(() => parseGenerateArgs(["--skins", "chatgpt,grok,", "--seed", "s", "--out", "o"]), /空段/);
  assert.throws(() => parseGenerateArgs(["--skins", "chatgpt,classic", "--seed", "s", "--out", "o"]), /未知皮肤/);
  assert.throws(() => parseGenerateArgs(["--skins", "chatgpt,chatgpt", "--seed", "s", "--out", "o"]), /重复请求/);
  assert.throws(() => parseGenerateArgs(["--seed", "s", "--out", "o"]), /--skins 必填/);
  assert.throws(() => parseGenerateArgs(["--skins", "chatgpt", "--out", "o"]), /--seed 必填/);
  assert.throws(() => parseGenerateArgs(["--skins", "chatgpt", "--seed", "s"]), /--out 必填/);
});

test("M2.4：输出目录必须位于 docs/validation/<日期>-skin-palette-redesign/<runId>/，越界拒绝", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const resolved = resolveGenerateOutputDirectory(path.join(ws.workstream, "pilot-r1"), {
    validationRoot: ws.validationRoot,
  });
  assert.equal(resolved, path.resolve(path.join(ws.workstream, "pilot-r1")));
  assert.throws(
    () => resolveGenerateOutputDirectory(path.join(ws.root, "public", "x"), { validationRoot: ws.validationRoot }),
    /docs\/validation/,
    "越界输出拒绝",
  );
  assert.throws(
    () =>
      resolveGenerateOutputDirectory(path.join(ws.validationRoot, "other-workstream", "r1"), {
        validationRoot: ws.validationRoot,
      }),
    /skin-palette-redesign/,
    "非本工作流目录拒绝",
  );
  assert.throws(
    () => resolveGenerateOutputDirectory(ws.workstream, { validationRoot: ws.validationRoot }),
    /skin-palette-redesign/,
    "缺 runId 一级拒绝",
  );
  if (process.platform === "win32") {
    assert.ok(
      resolveGenerateOutputDirectory(path.join(ws.workstream.toUpperCase(), "r1"), {
        validationRoot: ws.validationRoot,
      }),
      "Windows 大小写折叠后同一目录仍合法",
    );
  }
});

test("M2.4：成功路径退出 0——落盘为规范字节、状态与摘要自洽、日志注明尚待浏览器与视觉评审", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-ok");
  const lines = [];
  const result = await runGenerate({
    skins: ["chatgpt", "grok"],
    seed: "palette-redesign-v1",
    out,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    now: () => M24_FIXED_NOW,
    log: (line) => lines.push(line),
  });
  assert.equal(result.exitCode, GENERATE_EXIT_CODES.ok);
  assert.equal(result.status, "ok");

  const candidatesText = await readFile(path.join(out, "candidates.json"), "utf8");
  const candidateSet = JSON.parse(candidatesText);
  assert.equal(candidatesText, canonicalFileContent(candidateSet), "落盘规范：canonicalJson + 一个末尾换行");
  assert.equal(candidateSet.candidateSetHash, result.candidateSetHash);
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => `${candidate.skinId}:${candidate.variant}`),
    ["chatgpt:a", "chatgpt:b", "grok:a", "grok:b"],
    "基线配方每皮肤 a/b 存活、c 去重",
  );

  const run = JSON.parse(await readFile(path.join(out, "run.json"), "utf8"));
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.kind, "skin-palette-generate");
  assert.equal(run.generatedAt, M24_FIXED_NOW);
  assert.equal(run.status, "ok");
  assert.deepEqual(run.insufficientSkins, []);
  assert.deepEqual(run.hardFailures, []);
  assert.deepEqual(run.counts.bySkin, { chatgpt: 2, grok: 2 });
  assert.equal(run.candidateSetHash, result.candidateSetHash);
  assert.equal(run.derivationHash, M23_DERIVATION_HASH, "derivationHash = public/skins.js 内容摘要（总计划 §4.1）");
  assert.equal(
    run.sourceHashes[path.resolve(ws.profilesPath)],
    createHash("sha256").update(readFileSync(ws.profilesPath)).digest("hex"),
    "profiles 文件原始字节摘要留档",
  );
  assert.equal(run.command.profilesOverride, true, "--profiles 显式覆盖留痕");
  assert.equal(run.command.policyOverride, true);
  const notes = run.notes.join("\n");
  assert.ok(notes.includes("浏览器"), "run.json 注明尚待浏览器实测");
  assert.ok(notes.includes("视觉评审"), "run.json 注明尚待视觉评审");
  const joined = lines.join("\n");
  assert.ok(joined.includes("生成完成"), "日志报告生成完成");
  assert.ok(joined.includes("视觉评审"), "生成日志明确尚待视觉评审");
  assert.ok(joined.includes("浏览器"), "生成日志明确尚待浏览器实测");
});

test("M2.4：重复运行在不同新目录得到同一候选内容摘要，candidates.json 逐字相同", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const options = (runId) => ({
    skins: ["grok"],
    seed: "palette-redesign-v1",
    out: path.join(ws.workstream, runId),
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    now: () => M24_FIXED_NOW,
    log: () => {},
  });
  const first = await runGenerate(options("run-1"));
  const second = await runGenerate(options("run-2"));
  assert.equal(first.candidateSetHash, second.candidateSetHash, "候选内容摘要一致");
  const text1 = await readFile(path.join(ws.workstream, "run-1", "candidates.json"), "utf8");
  const text2 = await readFile(path.join(ws.workstream, "run-2", "candidates.json"), "utf8");
  assert.equal(text1, text2, "同输入重复生成 candidates.json 必须逐字相同（总计划 §4.1）");
});

test("M2.4：某皮肤全变体无解退出 2——已完成皮肤结果与失败记录仍保存", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-conflict");
  const lines = [];
  const result = await runGenerate({
    skins: ["chatgpt", "grok"],
    seed: "palette-redesign-v1",
    out,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m23Evaluate(m24SkinGatedRoles("grok")),
    validationRoot: ws.validationRoot,
    now: () => M24_FIXED_NOW,
    log: (line) => lines.push(line),
  });
  assert.equal(result.exitCode, GENERATE_EXIT_CODES.conflict);
  assert.equal(result.status, "conflict");

  const candidateSet = JSON.parse(await readFile(path.join(out, "candidates.json"), "utf8"));
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => `${candidate.skinId}:${candidate.variant}`),
    ["chatgpt:a", "chatgpt:b"],
    "已完成皮肤结果保存",
  );
  assert.equal(
    candidateSet.rejected.filter((record) => record.code === "UNSATISFIABLE" && record.skinId === "grok").length,
    6,
    "grok 三变体 × 两模式逐模式留档",
  );

  const run = JSON.parse(await readFile(path.join(out, "run.json"), "utf8"));
  assert.deepEqual(run.insufficientSkins, ["grok"]);
  assert.equal(run.hardFailures.length, 6);
  assert.ok(run.hardFailures.every((failure) => failure.code === "UNSATISFIABLE" && failure.skinId === "grok"));
  assert.deepEqual(run.counts.bySkin, { chatgpt: 2, grok: 0 });
  const joined = lines.join("\n");
  assert.ok(joined.includes("UNSATISFIABLE grok"), "日志列出冲突明细");
  assert.ok(joined.includes("退出码 2"), "日志标明冲突退出码");
});

test("M2.4：输出目录已有结果拒绝覆盖——报 RESULTS_EXIST 且已有文件原样保留", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-keep");
  const base = {
    skins: ["grok"],
    seed: "palette-redesign-v1",
    out,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    log: () => {},
  };
  await runGenerate(base);
  const before = await readFile(path.join(out, "candidates.json"), "utf8");
  await assert.rejects(
    () => runGenerate({ ...base, evaluate: m23Evaluate(m24SkinGatedRoles("grok")) }),
    (error) => error instanceof GenerateCliError && error.code === "RESULTS_EXIST",
    "已有结果目录拒绝重跑",
  );
  assert.equal(await readFile(path.join(out, "candidates.json"), "utf8"), before, "已有文件未被改写");
  // 空目录允许首次生成
  const emptyDir = path.join(ws.workstream, "run-empty");
  await mkdir(emptyDir, { recursive: true });
  const inEmpty = await runGenerate({ ...base, out: emptyDir });
  assert.equal(inEmpty.exitCode, GENERATE_EXIT_CODES.ok);
});

test("M2.4：输入错误退出 1 且不落盘——缺配方/坏 JSON 在写盘前拒绝", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-err");
  const base = {
    seed: "s",
    out,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    log: () => {},
  };
  await writeFile(path.join(ws.root, "only-chatgpt.json"), JSON.stringify({ chatgpt: makeM23Profile() }), "utf8");
  await assert.rejects(
    () => runGenerate({ ...base, skins: ["grok"], profilesPath: path.join(ws.root, "only-chatgpt.json") }),
    (error) => error instanceof GenerateCliError && error.code === "GENERATION_INPUT" && /grok/.test(error.message),
    "请求皮肤缺配方退出 1",
  );
  assert.equal(existsSync(out), false, "输入错误先于任何写盘，输出目录未创建");
  await writeFile(path.join(ws.root, "broken.json"), "{ not json", "utf8");
  await assert.rejects(
    () => runGenerate({ ...base, skins: ["chatgpt"], profilesPath: path.join(ws.root, "broken.json") }),
    (error) => error.code === "PROFILES_INVALID_JSON",
  );
  await assert.rejects(
    () => runGenerate({ ...base, skins: ["chatgpt"], profilesPath: path.join(ws.root, "nope.json") }),
    (error) => error.code === "PROFILES_UNREADABLE",
  );
  await assert.rejects(
    () =>
      runGenerate({
        ...base,
        skins: ["chatgpt"],
        profilesPath: ws.profilesPath,
        policyPath: path.join(ws.root, "nope.json"),
      }),
    (error) => error.code === "POLICY_UNREADABLE",
  );
});

test("M2.4：直接运行判据——未知参数退出 1、越界输出拒绝、导入模块不执行 CLI", () => {
  const unknownArg = spawnSync(
    process.execPath,
    [M24_CLI_PATH, "--skins", "chatgpt", "--seed", "s", "--out", "o", "--wat", "x"],
    { encoding: "utf8" },
  );
  assert.equal(unknownArg.status, 1, "未知参数退出 1");
  assert.ok(unknownArg.stderr.includes("UNKNOWN_ARGUMENT"));
  const outside = spawnSync(
    process.execPath,
    [M24_CLI_PATH, "--skins", "chatgpt", "--seed", "s", "--out", path.join(tmpdir(), "m24-outside")],
    { encoding: "utf8" },
  );
  assert.equal(outside.status, 1, "越界输出退出 1");
  assert.ok(outside.stderr.includes("OUTPUT_OUTSIDE_VALIDATION"));
  const importProbe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(pathToFileURL(M24_CLI_PATH).href)});` +
        `if (typeof mod.runGenerate !== "function" || typeof mod.parseGenerateArgs !== "function") process.exit(3);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(importProbe.status, 0, "导入实现不执行 CLI（卡面），导出函数可用");
  assert.equal(importProbe.stdout.trim(), "", "导入不产生任何输出");
});

test("M2.4：evaluatePalette 解析——注入优先；真件缺失动态报 EVALUATE_UNAVAILABLE，不造第二份实现", async (t) => {
  const ws = await m24Workspace({ skins: ["chatgpt"] });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const base = {
    skins: ["chatgpt"],
    seed: "s",
    out: path.join(ws.workstream, "run-eval"),
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    validationRoot: ws.validationRoot,
    log: () => {},
  };
  await assert.rejects(
    () =>
      runGenerate({
        ...base,
        loadEvaluate: async () => {
          throw new Error("M3.1 未落地");
        },
      }),
    (error) => error instanceof GenerateCliError && error.code === "EVALUATE_UNAVAILABLE" && /M3.1/.test(error.message),
    "真件加载失败即输入错误，不造第二份评估实现",
  );
  await assert.rejects(
    () => runGenerate({ ...base, evaluate: "not-a-function" }),
    (error) => error.code === "EVALUATE_INVALID",
    "注入非函数显式拒绝",
  );
  await assert.rejects(
    () => runGenerate({ ...base, loadEvaluate: async () => ({ notEvaluate: 1 }) }),
    (error) => error.code === "EVALUATE_UNAVAILABLE",
    "真件模块无 evaluatePalette 导出报同码",
  );
  const viaLoader = await runGenerate({ ...base, loadEvaluate: async () => ({ evaluatePalette: m24Evaluate }) });
  assert.equal(viaLoader.exitCode, GENERATE_EXIT_CODES.ok, "loadEvaluate 提供真件等价物时主路径可用");
  assert.equal(viaLoader.run.evaluator.source, "injected", "自定义 loader 不猜固定模块文件，来源记 injected");
});

test("M2.4：junction/符号链接不能把输出目录重定向到 docs/validation 之外（真实路径复检）", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const outsideTarget = path.join(ws.root, "outside-target");
  await mkdir(outsideTarget, { recursive: true });
  const junctionOut = path.join(ws.workstream, "run-junction");
  symlinkSync(outsideTarget, junctionOut, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => resolveGenerateOutputDirectory(junctionOut, { validationRoot: ws.validationRoot }),
    (error) => error instanceof GenerateCliError && error.code === "OUTPUT_OUTSIDE_VALIDATION",
    "已存在的 junction 在检查期即被真实路径还原拒绝",
  );
  await assert.rejects(
    () =>
      runGenerate({
        skins: ["grok"],
        seed: "s",
        out: junctionOut,
        profilesPath: ws.profilesPath,
        policyPath: ws.policyPath,
        evaluate: m24Evaluate,
        validationRoot: ws.validationRoot,
        log: () => {},
      }),
    (error) => error.code === "OUTPUT_OUTSIDE_VALIDATION",
    "runGenerate 全流程同样拒绝",
  );
  assert.equal(existsSync(path.join(outsideTarget, "candidates.json")), false, "界外未写入任何文件");
  assert.ok(
    resolveGenerateOutputDirectory(path.join(ws.workstream, "run-normal"), { validationRoot: ws.validationRoot }),
    "同名普通目录不受影响",
  );
});

test("M2.4：policy 未经 M0 契约校验即拒绝（POLICY_INVALID），写盘前拦截", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-policy");
  const badPolicy = path.join(ws.root, "bad-policy.json");
  await writeFile(badPolicy, JSON.stringify({ schemaVersion: 1 }), "utf8");
  await assert.rejects(
    () =>
      runGenerate({
        skins: ["grok"],
        seed: "s",
        out,
        profilesPath: ws.profilesPath,
        policyPath: badPolicy,
        evaluate: m24Evaluate,
        validationRoot: ws.validationRoot,
        log: () => {},
      }),
    (error) =>
      error instanceof GenerateCliError && error.code === "POLICY_INVALID" && /M0 契约校验/.test(error.message),
    "缺阈值/预算字段的空壳 policy 显式拒绝",
  );
  assert.equal(existsSync(out), false, "契约校验失败不落盘");
});

test("M2.4：第二个文件写入失败回滚本次已写文件——半套结果不留盘，同目录重试可行", async (t) => {
  const ws = await m24Workspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const out = path.join(ws.workstream, "run-rollback");
  const base = {
    skins: ["grok"],
    seed: "s",
    out,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    log: () => {},
  };
  await assert.rejects(
    () =>
      runGenerate({
        ...base,
        writeFile: async (filePath, content, encoding) => {
          if (String(filePath).includes("run.json.tmp-")) throw new Error("disk full");
          return writeFile(filePath, content, encoding);
        },
      }),
    (error) => error.code === "WRITE_FAILED" && /disk full/.test(error.message),
    "run.json 写入失败显式报错",
  );
  assert.equal(existsSync(path.join(out, "candidates.json")), false, "已写的 candidates.json 被回滚");
  assert.equal(existsSync(path.join(out, "run.json")), false);
  const leftovers = (await readdir(out)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "临时文件无残留");
  const retried = await runGenerate(base);
  assert.equal(retried.exitCode, GENERATE_EXIT_CODES.ok, "同目录重试成功（未被半套结果卡死）");
});

test("M2.4：实际评估器进入源文件摘要——模块来源记 path+sha256，注入来源记 injected", async (t) => {
  const ws = await m24Workspace({ skins: ["grok"] });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  // 全通过的独立评估器 fixture：模拟 M3.1 真件就位后的默认 loader 动态解析路径
  const fixtureEvaluate = path.join(ws.root, "fixture-evaluate.mjs");
  await writeFile(
    fixtureEvaluate,
    [
      "export const evaluatePalette = () => ({",
      "  entries: [",
      `    { roleId: "page.body-text", required: true, status: "pass", ratio: 21, threshold: 4.5, foregroundTokens: ["textPrimary"], backgroundTokens: ["pageBackground"] },`,
      `    { roleId: "panel.metric-value", required: true, status: "pass", ratio: 21, threshold: 4.5, foregroundTokens: ["textPrimary"], backgroundTokens: ["panelBackground"] },`,
      `    { roleId: "panel.metric-label", required: true, status: "pass", ratio: 21, threshold: 4.5, foregroundTokens: ["textSecondary"], backgroundTokens: ["panelBackground"] },`,
      `    { roleId: "toast.quota-status", required: true, status: "pass", ratio: 21, threshold: 3, foregroundTokens: ["accent"], backgroundTokens: ["panelBackground"] },`,
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );
  const out = path.join(ws.workstream, "run-eval-module");
  const viaModule = await runGenerate({
    skins: ["grok"],
    seed: "s",
    out,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluateModulePath: fixtureEvaluate,
    validationRoot: ws.validationRoot,
    log: () => {},
  });
  assert.equal(viaModule.exitCode, GENERATE_EXIT_CODES.ok, "默认 loader 按 evaluateModulePath 动态解析真件");
  const run = JSON.parse(await readFile(path.join(out, "run.json"), "utf8"));
  assert.equal(run.evaluator.source, "module");
  assert.equal(run.evaluator.path, path.resolve(fixtureEvaluate));
  assert.equal(
    run.evaluator.sha256,
    createHash("sha256").update(readFileSync(fixtureEvaluate)).digest("hex"),
    "评估器模块文件原始字节摘要留档",
  );
  assert.equal(run.sourceHashes[path.resolve(fixtureEvaluate)], run.evaluator.sha256, "评估器进源文件摘要表");
  const outInjected = path.join(ws.workstream, "run-eval-injected");
  const viaInjected = await runGenerate({
    skins: ["grok"],
    seed: "s",
    out: outInjected,
    profilesPath: ws.profilesPath,
    policyPath: ws.policyPath,
    evaluate: m24Evaluate,
    validationRoot: ws.validationRoot,
    log: () => {},
  });
  assert.equal(viaInjected.run.evaluator.source, "injected", "注入评估器来源记 injected");
  assert.equal(viaInjected.run.sourceHashes[path.resolve(fixtureEvaluate)], undefined, "注入时不猜模块文件");
});
