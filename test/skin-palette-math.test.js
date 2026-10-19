/**
 * M1.3 pure colour math acceptance tests (node --test).
 *
 * Anchored against externally known results — OKLab reference values from the
 * author's published definition, WCAG luminance/contrast numbers, the
 * documented #767676 8-bit contrast threshold, and browser-computable rgba()
 * composites — never only by inverting our own transforms.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SRGB_GAMUT_EPSILON,
  compositeSrgb,
  contrastRatio,
  fitSrgbGamut,
  hexToSrgb,
  isInSrgbGamut,
  okDistance,
  oklabToOklch,
  oklabToSrgb,
  oklchToOklab,
  relativeLuminance,
  srgbToHex,
  srgbToOklab,
} from "../scripts/skin-palette/color-math.mjs";

const closeTo = (actual, expected, epsilon, label) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} 与 ${expected} 相差超过 ${epsilon}`);

test("hexToSrgb / srgbToHex：编码值 0..1、大小写与 # 可选、HEX 只舍一次、色域闸门", () => {
  assert.deepEqual(hexToSrgb("#FFFFFF"), [1, 1, 1]);
  assert.deepEqual(hexToSrgb("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToSrgb("#dce4f7"), hexToSrgb("#DCE4F7"), "大小写等价");
  assert.deepEqual(hexToSrgb("3870FF"), hexToSrgb("#3870FF"), "# 可省略");
  assert.deepEqual(hexToSrgb("#0AF"), hexToSrgb("#00AAFF"), "三位缩写展开");
  assert.equal(srgbToHex([1, 1, 1]), "#FFFFFF");
  assert.equal(srgbToHex([0.5, 0, 0.5]), "#800080", "127.5 一次舍入到 128");
  assert.equal(srgbToHex([127.4 / 255, 0, 0]), "#7F0000", "舍入边界之下");
  assert.equal(srgbToHex([127.6 / 255, 0, 0]), "#800000", "舍入边界之上");
  assert.throws(() => srgbToHex([1.001, 0, 0]), /超出 sRGB 色域/, "明显超界必须报错");
  assert.throws(() => srgbToHex([-0.5, 0, 0]), /超出 sRGB 色域/);
  assert.equal(srgbToHex([1 + SRGB_GAMUT_EPSILON / 10, 0, 0]), "#FF0000", "误差内按边界收敛");
  assert.equal(srgbToHex([-SRGB_GAMUT_EPSILON / 10, 0, 0]), "#000000");
  assert.throws(() => hexToSrgb("#12345"), /无法解析/);
  assert.throws(() => hexToSrgb("#GGHHII"), /无法解析/);
  assert.throws(() => hexToSrgb(42), /需要十六进制字符串/);
});

test("WCAG 亮度与对比度：外部已知值（21:1、1:1、中灰 0.21586、#767676 8-bit 阈值）", () => {
  assert.equal(relativeLuminance([1, 1, 1]), 1);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  closeTo(relativeLuminance(hexToSrgb("#808080")), 0.2158605, 2e-6, "#808080 亮度");
  closeTo(contrastRatio("#FFFFFF", "#000000"), 21, 1e-9, "黑白 21:1");
  closeTo(contrastRatio("#808080", "#000000"), 5.3172, 2e-3, "中灰对黑 ≈5.32");
  assert.equal(contrastRatio("#3870FF", "#3870FF"), 1, "相同色 1:1");
  // 4.499 不通过的具象化：文档化的 8-bit 阈值对——#777777 对白 ~4.47 不及格，#767676 ~4.54 及格
  const below = contrastRatio("#777777", "#FFFFFF");
  const above = contrastRatio("#767676", "#FFFFFF");
  assert.ok(below < 4.5 && below > 4.4, `#777777 对白应 ≈4.47，收到 ${below}`);
  assert.ok(above > 4.5 && above < 4.6, `#767676 对白应 ≈4.54，收到 ${above}`);
  assert.throws(() => relativeLuminance([0.5, 0.5]), /三通道数组/);
  assert.throws(() => contrastRatio("#808080", [0.5, Number.NaN, 0.5]), /有限数值/);
});

test("OKLab 外部参考值：红绿蓝白黑与红相位（作者公开矩阵）", () => {
  const red = srgbToOklab(hexToSrgb("#FF0000"));
  closeTo(red.L, 0.6279554, 2e-4, "红 L");
  closeTo(red.a, 0.2248631, 2e-4, "红 a");
  closeTo(red.b, 0.1258463, 2e-4, "红 b");
  const green = srgbToOklab(hexToSrgb("#00FF00"));
  closeTo(green.L, 0.8664398, 2e-4, "绿 L");
  closeTo(green.a, -0.2338875, 2e-4, "绿 a");
  closeTo(green.b, 0.1794984, 2e-4, "绿 b");
  const blue = srgbToOklab(hexToSrgb("#0000FF"));
  closeTo(blue.L, 0.4520137, 2e-4, "蓝 L");
  closeTo(blue.a, -0.0324566, 2e-4, "蓝 a");
  closeTo(blue.b, -0.3115281, 2e-4, "蓝 b");
  const white = srgbToOklab(hexToSrgb("#FFFFFF"));
  closeTo(white.L, 1, 1e-6, "白 L（L/C 不乘 100）");
  closeTo(white.a, 0, 1e-7, "白 a");
  closeTo(white.b, 0, 1e-7, "白 b");
  const black = srgbToOklab(hexToSrgb("#000000"));
  closeTo(black.L, 0, 1e-12, "黑 L");
  closeTo(black.a, 0, 1e-12, "黑 a");
  closeTo(black.b, 0, 1e-12, "黑 b");
  closeTo(oklabToOklch(red).H, 29.23, 0.3, "红相位（H 归一化 [0,360)）");
  const gray = oklabToOklch(srgbToOklab(hexToSrgb("#808080")));
  closeTo(gray.L, 0.5999, 2e-3, "中灰 L");
  assert.ok(gray.C <= 1e-7, "中灰彩度在浮点噪声底（~2e-8）以下");
  assert.equal(gray.H, 0, "近零彩度约定 H=0，不是 NaN/180");
});

test("往返：sRGB ↔ OKLab ↔ sRGB 精确回到原 HEX；OKLCH 往返不漂移", () => {
  const samples = [
    "#000000",
    "#111111",
    "#808080",
    "#B9C9EE",
    "#DCE4F7",
    "#3870FF",
    "#2F855A",
    "#C05621",
    "#123456",
    "#F3F6FC",
    "#71699F",
    "#52407D",
    "#807EB0",
    "#0891B2",
    "#FB923C",
    "#1A5233",
    "#74270D",
  ];
  for (const hex of samples) {
    assert.equal(srgbToHex(oklabToSrgb(srgbToOklab(hexToSrgb(hex)))), hex.toUpperCase(), `${hex} 往返必须精确`);
    const lch = oklabToOklch(srgbToOklab(hexToSrgb(hex)));
    const back = oklabToOklch(oklchToOklab(lch));
    closeTo(back.L, lch.L, 1e-12, `${hex} L 往返`);
    closeTo(back.C, lch.C, 1e-12, `${hex} C 往返`);
    closeTo(back.H, lch.H, 1e-9, `${hex} H 往返`);
  }
});

test("compositeSrgb：CSS sRGB 合成（浏览器已知结果），亮度取自有效色而非 alpha 内插", () => {
  assert.equal(srgbToHex(compositeSrgb("#FFFFFF", 0.5, "#000000")), "#808080");
  assert.equal(srgbToHex(compositeSrgb("#FFFFFF", 0.5, "#FFFFFF")), "#FFFFFF", "同背景不产生变化");
  assert.equal(srgbToHex(compositeSrgb("#FF0000", 0.5, "#0000FF")), "#800080", "rgba(255,0,0,.5) over 蓝");
  assert.equal(srgbToHex(compositeSrgb("#FF0000", 1, "#0000FF")), "#FF0000", "alpha=1 即前景");
  assert.equal(srgbToHex(compositeSrgb("#FF0000", 0, "#0000FF")), "#0000FF", "alpha=0 即背景");
  const effective = compositeSrgb("#FFFFFF", 0.5, "#000000");
  // 有效色是 [0.5, 0.5, 0.5]（烤制后才成为 #808080）：其亮度 = decode(0.5)，
  // 三个亮度系数之和为 1，绝不是 alpha 线性内插出的 0.5。
  const linearHalf = ((0.5 + 0.055) / 1.055) ** 2.4;
  closeTo(relativeLuminance(effective), linearHalf, 1e-12, "有效色亮度 = decode(0.5)");
  const effectiveRatio = contrastRatio(effective, "#000000");
  assert.ok(
    effectiveRatio > 5.2 && effectiveRatio < 5.35,
    `有效色对黑应 ≈5.28（烤制 #808080 为 5.32），收到 ${effectiveRatio}`,
  );
  assert.ok(Math.abs(relativeLuminance(effective) - 0.5) > 0.1, "不得把 alpha 乘进亮度（线性内插会得到 0.5）");
  assert.throws(() => compositeSrgb("#FFFFFF", 1.5, "#000000"), /alpha 必须落在/);
  assert.throws(() => compositeSrgb("#FFFFFF", Number.NaN, "#000000"), /有限数值/);
  assert.throws(() => compositeSrgb([0.5, 0.5], 0.5, "#000000"), /三通道数组/);
});

test("fitSrgbGamut：超色域降 C 且 L/H 不动；域内原样通过；H 跨 0° 不产生 NaN", () => {
  const inGamut = fitSrgbGamut({ L: 0.6, C: 0.05, H: 200 });
  assert.equal(inGamut.chromaReduced, false, "域内不做缩减");
  assert.equal(inGamut.lch.C, 0.05);
  assert.equal(inGamut.lch.H, 200);
  assert.ok(isInSrgbGamut(inGamut.rgb));

  const extreme = fitSrgbGamut({ L: 0.8, C: 0.4, H: 29.23 });
  assert.equal(extreme.chromaReduced, true, "明显超界必须降 C");
  assert.ok(extreme.lch.C > 0 && extreme.lch.C < 0.4, `色度须被压低，收到 ${extreme.lch.C}`);
  closeTo(extreme.lch.L, 0.8, 1e-12, "L 保持");
  closeTo(extreme.lch.H, 29.23, 1e-9, "H 保持");
  for (const channel of extreme.rgb) {
    assert.ok(channel >= -SRGB_GAMUT_EPSILON && channel <= 1 + SRGB_GAMUT_EPSILON, `通道须在误差内进域：${channel}`);
  }
  assert.doesNotThrow(() => srgbToHex(extreme.rgb), "收敛结果必须可直接转 HEX");
  // 二分按卡面停在 C 精度 1e-7（判定容忍），回读角度误差 ~1e-5° 属设计内
  closeTo(oklabToOklch(srgbToOklab(extreme.rgb)).H, 29.23, 1e-3, "回读相位仍保持");

  for (const H of [0, 10, 180, 350, 359.9, 720.5, -30]) {
    const fitted = fitSrgbGamut({ L: 0.6, C: 0.3, H });
    assert.ok(Number.isFinite(fitted.rgb[0]) && Number.isFinite(fitted.rgb[2]), `H=${H} 不得产生 NaN`);
    assert.ok(fitted.lch.H >= 0 && fitted.lch.H < 360, `H=${H} 须归一化到 [0,360)，收到 ${fitted.lch.H}`);
  }
  closeTo(
    oklchToOklab({ L: 0.5, C: 0.1, H: 350 }).b,
    0.1 * Math.sin((350 * Math.PI) / 180),
    1e-15,
    "H 跨 0° 的 b 分量",
  );
  assert.throws(() => fitSrgbGamut({ L: Number.NaN, C: 0.1, H: 0 }), /有限数值/);
  assert.throws(() => fitSrgbGamut({ L: 1.5, C: 0.1, H: 0 }), /必须落在 \[0, 1\]/);
  assert.throws(() => fitSrgbGamut({ L: 0.5, C: -0.1, H: 0 }), /不能为负/);
  assert.throws(() => oklchToOklab({ L: 0.5, C: 0.1 }), /有限数值/, "缺少 H 显式报错");
});

test("健壮性：超大有限 H 先归一化不溢出；稀疏数组空位显式报错", () => {
  // Number.MAX_VALUE 直接乘 π 会溢出为 Infinity，cos/sin 随即产生 NaN；
  // 归一化到 [0, 360) 之后任何有限 H 都必须给出有限结果。
  for (const H of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const lab = oklchToOklab({ L: 0.5, C: 0.1, H });
    assert.ok(Number.isFinite(lab.a) && Number.isFinite(lab.b), `H=${H} 不得产生 NaN/Infinity`);
    const fitted = fitSrgbGamut({ L: 0.6, C: 0.3, H });
    assert.ok(
      fitted.rgb.every((channel) => Number.isFinite(channel)),
      `fit H=${H} 不得产生 NaN`,
    );
    assert.ok(fitted.lch.H >= 0 && fitted.lch.H < 360, `fit H=${H} 回读仍须落在 [0,360)`);
  }
  // 角度周期性：新归一化路径下 H+720 与 H 必须给出同一 OKLab。
  const base = oklchToOklab({ L: 0.5, C: 0.1, H: 30 });
  const shifted = oklchToOklab({ L: 0.5, C: 0.1, H: 750 });
  closeTo(base.a, shifted.a, 1e-12, "H+720 的 a 分量与 H 一致");
  closeTo(base.b, shifted.b, 1e-12, "H+720 的 b 分量与 H 一致");
  // Array.prototype.every 会跳过稀疏空位，[0, , 0] 曾可能被误判在域内；
  // 现在空位读出 undefined，必须显式报错（同类路径 srgbToHex 一并锁定）。
  const sparse = new Array(3);
  sparse[0] = 0;
  sparse[2] = 0;
  assert.throws(() => isInSrgbGamut(sparse), /有限数值/, "稀疏空位必须显式报错");
  assert.throws(() => srgbToHex(sparse), /有限数值/, "同类路径 srgbToHex 也须显式报错");
});

test("okDistance：固定 100 倍 OKLab 欧氏距离（内部诊断量）", () => {
  const white = srgbToOklab(hexToSrgb("#FFFFFF"));
  const black = srgbToOklab(hexToSrgb("#000000"));
  assert.equal(okDistance(white, white), 0);
  closeTo(okDistance(white, black), 100, 1e-6, "黑白距离 = L 差 1 × 100");
  const red = srgbToOklab(hexToSrgb("#FF0000"));
  const blue = srgbToOklab(hexToSrgb("#0000FF"));
  closeTo(okDistance(red, blue), 53.709, 0.1, "红蓝距离（参考值推算）");
  assert.equal(okDistance(red, blue), okDistance(blue, red), "对称");
  assert.throws(() => okDistance({ L: 0.5, a: 0, b: "x" }, black), /有限数值/);
});

test("纯度：模块零导入，不触碰 DOM/随机/文件/正式 palette", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/color-math.mjs", import.meta.url), "utf8");
  assert.ok(!/^import\s/m.test(source), "不得导入任何模块");
  for (const banned of ["document", "window", "Math.random", "readFile", "writeFile", "skin-palettes"]) {
    assert.ok(!source.includes(banned), `不得引用 ${banned}`);
  }
});
